import {
  BootstrapResult,
  BootstrapTier,
  BuildOrchestrator,
  getPackagesForTier,
  InstallOrchestrator,
  Logger,
  PackageCreator,
  PackageService,
  ProjectService,
} from '@b64/sfpm-core'
import {confirm, select} from '@inquirer/prompts'
import {Flags} from '@oclif/core'
import {Org} from '@salesforce/core'
import chalk from 'chalk'
import fs from 'fs-extra'
import {execSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import ora, {type Ora} from 'ora'

import SfpmCommand from '../sfpm-command.js'
import {
  errorBox, infoBox, successBox, warningBox,
} from '../ui/boxes.js'
import {BuildProgressRenderer, OutputMode} from '../ui/build-progress-renderer.js'
import {InstallProgressRenderer} from '../ui/install-progress-renderer.js'

const BOOTSTRAP_REPO = 'https://github.com/b64hub/sfpm-bootstrap'

const TIER_DESCRIPTIONS: Record<BootstrapTier, string> = {
  [BootstrapTier.Core]: 'sfpm-artifact only -- artifact tracking custom setting',
  [BootstrapTier.Full]: 'All packages -- adds artifact history & UI components',
  [BootstrapTier.Pool]: 'sfpm-artifact + sfpm-orgs -- adds scratch org & sandbox pooling',
}

export default class Bootstrap extends SfpmCommand {
  static override description = 'Bootstrap SFPM packages into a production org'
  static override examples = [
    '<%= config.bin %> <%= command.id %> -o my-prod-org',
    '<%= config.bin %> <%= command.id %> -o my-prod-org --tier core',
    '<%= config.bin %> <%= command.id %> -o my-prod-org --tier full --json',
    '<%= config.bin %> <%= command.id %> -o my-prod-org --force',
  ]
  static override flags = {
    force: Flags.boolean({char: 'f', description: 'force re-install even if packages are already installed'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'target-org': Flags.string({char: 'o', description: 'target org username (must also be a DevHub)', required: true}),
    tier: Flags.string({
      char: 't',
      description: 'package tier to install',
      options: ['core', 'pool', 'full'],
    }),
  }

  public async execute(): Promise<BootstrapResult | void> {
    const {flags} = await this.parse(Bootstrap)

    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive'
    const isInteractive = mode === 'interactive'

    const logger: Logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }

    // ── Step 1: Select tier ─────────────────────────────────────────────
    const tier = await this.resolveTier(flags.tier as BootstrapTier | undefined, isInteractive)
    const selectedPackages = getPackagesForTier(tier)
    const packageNames = selectedPackages.map(p => p.name)

    if (isInteractive) {
      this.log(infoBox('Bootstrap', {
        Packages: packageNames.join(', '),
        'Target Org': flags['target-org'],
        Tier: tier,
      }))
    }

    // ── Step 2: Clone bootstrap repo ────────────────────────────────────
    const tmpDir = await this.cloneRepo(isInteractive)

    try {
      // ── Step 3: Connect to org and verify DevHub ────────────────────
      const org = await this.connectToOrg(flags['target-org'], isInteractive)

      // ── Step 4: Check if packages are already installed ─────────────
      if (!flags.force) {
        const alreadyInstalled = await this.checkInstalledPackages(org, packageNames, logger)
        if (alreadyInstalled.length > 0) {
          if (isInteractive) {
            this.log(warningBox('Already Installed', {
              Hint: 'Use --force to re-install',
              Packages: alreadyInstalled.join(', '),
            }))
          }

          if (flags.json) {
            const result: BootstrapResult = {
              packages: alreadyInstalled.map(name => ({
                packageName: name, skipped: true, success: true,
              })),
              success: true,
              targetOrg: flags['target-org'],
              tier,
            }
            this.logJson(result)
            return result
          }

          return
        }
      }

      // ── Step 5: Ensure Package2 containers exist in DevHub ──────────
      const creator = new PackageCreator(org, logger)
      await creator.ensurePackages(selectedPackages, tmpDir, async name => {
        if (!isInteractive) return true
        return confirm({
          default: true,
          message: `Package '${name}' does not exist in the DevHub. Create it?`,
        })
      })

      // ── Step 6: Load project from cloned repo ─────────────────────
      const projectService = await ProjectService.create(tmpDir)
      const projectConfig = projectService.getProjectConfig()
      const projectGraph = projectService.getProjectGraph()
      const sfpmConfig = projectService.getSfpmConfig()

      // ── Step 7: Build packages ────────────────────────────────────
      if (isInteractive) {
        this.log(chalk.bold('\nBuilding packages...\n'))
      }

      const buildOptions = {
        devhubUsername: flags['target-org'],
        force: true,
        includeDependencies: true,
      }

      const buildOrchestrator = new BuildOrchestrator(
        projectConfig,
        projectGraph,
        buildOptions,
        logger,
        tmpDir,
      )

      const buildRenderer = new BuildProgressRenderer({
        logger: {
          error: (msgOrError: Error | string) => this.error(msgOrError),
          log: (msg: string) => this.log(msg),
        },
        mode,
      })
      buildRenderer.attachTo(buildOrchestrator as any)

      const buildResult = await buildOrchestrator.buildAll(packageNames)

      if (!buildResult.success) {
        const failedNames = buildResult.failedPackages.join(', ')
        if (flags.json) {
          const result: BootstrapResult = {
            packages: buildResult.results.map(p => ({
              error: p.error, packageName: p.packageName, skipped: p.skipped, success: p.success,
            })),
            success: false,
            targetOrg: flags['target-org'],
            tier,
          }
          this.logJson(result)
          return result
        }

        this.error(`Build failed for: ${failedNames}`, {exit: 1})
      }

      // ── Step 8: Install packages ──────────────────────────────────
      if (isInteractive) {
        this.log(chalk.bold('\nInstalling packages...\n'))
      }

      const installOptions = {
        force: flags.force,
        includeDependencies: true,
        targetOrg: flags['target-org'],
        trackHistory: sfpmConfig.artifacts?.trackHistory,
      }

      const installOrchestrator = new InstallOrchestrator(
        projectConfig,
        projectGraph,
        installOptions,
        logger,
      )

      const installRenderer = new InstallProgressRenderer({
        logger: {
          error: (msgOrError: Error | string) => this.error(msgOrError),
          log: (msg: string) => this.log(msg),
        },
        mode,
        targetOrg: flags['target-org'],
      })
      installRenderer.attachTo(installOrchestrator as any)

      const installResult = await installOrchestrator.installAll(packageNames)

      // ── Step 9: Report results ────────────────────────────────────
      const result: BootstrapResult = {
        packages: installResult.results.map(p => ({
          error: p.error, packageName: p.packageName, skipped: p.skipped, success: p.success,
        })),
        success: installResult.success,
        targetOrg: flags['target-org'],
        tier,
      }

      if (flags.json) {
        this.logJson(result)
        return result
      }

      if (installResult.success) {
        this.log(successBox('Bootstrap Complete', {
          Packages: packageNames.join(', '),
          'Target Org': flags['target-org'],
          Tier: tier,
        }))
      } else {
        const failedNames = installResult.failedPackages.join(', ')
        this.log(errorBox('Bootstrap Failed', {
          'Failed Packages': failedNames,
          'Target Org': flags['target-org'],
        }))
        this.error(`Install failed for: ${failedNames}`, {exit: 2})
      }

      return result
    } finally {
      // ── Step 10: Cleanup ──────────────────────────────────────────
      await this.cleanup(tmpDir, isInteractive)
    }
  }

  // ====================================================================
  // Private helpers
  // ====================================================================

  private async checkInstalledPackages(org: Org, packageNames: string[], logger: Logger): Promise<string[]> {
    const service = new PackageService(org, logger)
    const installed = await service.getAllInstalled2GPPackages()

    const installedNames = new Set(installed.map(p => p.name))
    return packageNames.filter(name => installedNames.has(name))
  }

  private async cleanup(tmpDir: string, isInteractive: boolean): Promise<void> {
    try {
      await fs.remove(tmpDir)
      if (isInteractive) {
        this.log(chalk.dim('\nCleaned up temporary files'))
      }
    } catch {
      this.warn(`Failed to clean up temporary directory: ${tmpDir}`)
    }
  }

  private async cloneRepo(isInteractive: boolean): Promise<string> {
    const tmpDir = path.join(os.tmpdir(), `sfpm-bootstrap-${Date.now()}`)

    let spinner: Ora | undefined
    if (isInteractive) {
      spinner = ora('Cloning bootstrap repository...').start()
    }

    try {
      execSync(`git clone --depth 1 ${BOOTSTRAP_REPO} ${tmpDir}`, {
        stdio: 'pipe',
        timeout: 60_000,
      })
      spinner?.succeed('Cloned bootstrap repository')
    } catch (error) {
      spinner?.fail('Failed to clone bootstrap repository')
      throw new Error(
        `Failed to clone ${BOOTSTRAP_REPO}. Ensure git is installed and the repo is accessible.`,
        {cause: error instanceof Error ? error : undefined},
      )
    }

    return tmpDir
  }

  private async connectToOrg(username: string, isInteractive: boolean): Promise<Org> {
    let spinner: Ora | undefined
    if (isInteractive) {
      spinner = ora(`Connecting to ${username}...`).start()
    }

    try {
      const org = await Org.create({aliasOrUsername: username})

      if (!await org.determineIfDevHubOrg()) {
        spinner?.fail(`${username} is not a DevHub`)
        throw new Error(`The target org '${username}' is not a DevHub. `
          + 'Bootstrap requires a DevHub org to create and build packages. '
          + 'Enable DevHub in Setup > Dev Hub or use a different org.')
      }

      spinner?.succeed(`Connected to ${username} (DevHub)`)
      return org
    } catch (error) {
      if (error instanceof Error && error.message.includes('not a DevHub')) {
        throw error
      }

      spinner?.fail(`Failed to connect to ${username}`)
      throw new Error(
        `Unable to connect to org '${username}'. Ensure the org is authenticated via 'sf org login'.`,
        {cause: error instanceof Error ? error : undefined},
      )
    }
  }

  private async resolveTier(flagValue: BootstrapTier | undefined, isInteractive: boolean): Promise<BootstrapTier> {
    if (flagValue) {
      return flagValue
    }

    if (!isInteractive) {
      return BootstrapTier.Full
    }

    return select<BootstrapTier>({
      choices: [
        {description: TIER_DESCRIPTIONS[BootstrapTier.Core], name: 'Core', value: BootstrapTier.Core},
        {description: TIER_DESCRIPTIONS[BootstrapTier.Pool], name: 'Pool', value: BootstrapTier.Pool},
        {description: TIER_DESCRIPTIONS[BootstrapTier.Full], name: 'Full', value: BootstrapTier.Full},
      ],
      message: 'Select which SFPM packages to install:',
    })
  }
}
