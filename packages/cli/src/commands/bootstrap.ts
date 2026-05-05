import {
  BootstrapPackageConfig,
  BootstrapResult,
  BootstrapTier,
  BuildOrchestrator,
  getPackagesForTier,
  InstallOrchestrator,
  Logger,
  PackageCreator,
  PackageService,
  ProjectService,
} from '@b64hub/sfpm-core'
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

interface BootstrapContext {
  isInteractive: boolean;
  logger: Logger;
  mode: OutputMode;
  targetOrg: string;
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
    const ctx: BootstrapContext = {
      isInteractive: mode === 'interactive',
      logger: this.createLogger(),
      mode,
      targetOrg: flags['target-org'],
    }

    const tier = await this.resolveTier(flags.tier as BootstrapTier | undefined, ctx.isInteractive)
    const selectedPackages = getPackagesForTier(tier)
    const packageNames = selectedPackages.map(p => p.name)

    if (ctx.isInteractive) {
      this.log(infoBox('Bootstrap', {
        Packages: packageNames.join(', '),
        'Target Org': ctx.targetOrg,
        Tier: tier,
      }))
    }

    const tmpDir = await this.cloneRepo(ctx.isInteractive)

    try {
      const org = await this.connectToOrg(ctx.targetOrg, ctx.isInteractive)

      const skipResult = await this.checkAndSkipIfInstalled(org, packageNames, tier, flags, ctx)
      if (skipResult) return skipResult

      await this.ensurePackageContainers(org, selectedPackages, tmpDir, ctx)

      const projectService = await ProjectService.create(tmpDir)

      const buildResult = await this.buildPackages(projectService, packageNames, tier, flags, ctx)
      if (!buildResult.success) return buildResult.result

      const result = await this.installPackages(projectService, packageNames, tier, flags, ctx)

      if (flags.json) {
        this.logJson(result)
        return result
      }

      this.renderFinalResult(result, packageNames, tier, ctx)
      return result
    } finally {
      await this.cleanup(tmpDir, ctx.isInteractive)
    }
  }

  // ====================================================================
  // Pipeline steps
  // ====================================================================

  private async buildPackages(
    projectService: ProjectService,
    packageNames: string[],
    tier: BootstrapTier,
    flags: {force?: boolean; json?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): Promise<{result?: BootstrapResult; success: boolean}> {
    if (ctx.isInteractive) {
      this.log(chalk.bold('\nBuilding packages...\n'))
    }

    const buildOrchestrator = new BuildOrchestrator(
      projectService.getDefinitionProvider(),
      projectService.getProjectGraph(),
      {devhubUsername: ctx.targetOrg, force: true, includeDependencies: true},
      ctx.logger,
      projectService.getDefinitionProvider().projectDir,
    )

    const buildRenderer = new BuildProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode: ctx.mode,
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
          targetOrg: ctx.targetOrg,
          tier,
        }
        this.logJson(result)
        return {result, success: false}
      }

      this.error(`Build failed for: ${failedNames}`, {exit: 1})
    }

    return {success: true}
  }

  private async checkAndSkipIfInstalled(
    org: Org,
    packageNames: string[],
    tier: BootstrapTier,
    flags: {force?: boolean; json?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): Promise<BootstrapResult | void> {
    if (flags.force) return

    const alreadyInstalled = await this.checkInstalledPackages(org, packageNames, ctx.logger)
    if (alreadyInstalled.length === 0) return

    if (ctx.isInteractive) {
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
        targetOrg: ctx.targetOrg,
        tier,
      }
      this.logJson(result)
      return result
    }
  }

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

  // ====================================================================
  // Private helpers
  // ====================================================================

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

  private createLogger(): Logger {
    return {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }
  }

  private async ensurePackageContainers(
    org: Org,
    selectedPackages: BootstrapPackageConfig[],
    tmpDir: string,
    ctx: BootstrapContext,
  ): Promise<void> {
    const creator = new PackageCreator(org, ctx.logger)
    await creator.ensurePackages(selectedPackages, tmpDir, async name => {
      if (!ctx.isInteractive) return true
      return confirm({
        default: true,
        message: `Package '${name}' does not exist in the DevHub. Create it?`,
      })
    })
  }

  private async installPackages(
    projectService: ProjectService,
    packageNames: string[],
    tier: BootstrapTier,
    flags: {force?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): Promise<BootstrapResult> {
    if (ctx.isInteractive) {
      this.log(chalk.bold('\nInstalling packages...\n'))
    }

    const sfpmConfig = projectService.getSfpmConfig()

    const installOrchestrator = new InstallOrchestrator(
      projectService.getDefinitionProvider(),
      projectService.getProjectGraph(),
      {
        force: flags.force,
        includeDependencies: true,
        targetOrg: ctx.targetOrg,
        trackHistory: sfpmConfig.artifacts?.trackHistory,
      },
      ctx.logger,
    )

    const installRenderer = new InstallProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode: ctx.mode,
      targetOrg: ctx.targetOrg,
    })
    installRenderer.attachTo(installOrchestrator as any)

    const installResult = await installOrchestrator.installAll(packageNames)

    return {
      packages: installResult.results.map(p => ({
        error: p.error, packageName: p.packageName, skipped: p.skipped, success: p.success,
      })),
      success: installResult.success,
      targetOrg: ctx.targetOrg,
      tier,
    }
  }

  private renderFinalResult(
    result: BootstrapResult,
    packageNames: string[],
    tier: BootstrapTier,
    ctx: BootstrapContext,
  ): void {
    if (result.success) {
      this.log(successBox('Bootstrap Complete', {
        Packages: packageNames.join(', '),
        'Target Org': ctx.targetOrg,
        Tier: tier,
      }))
    } else {
      const failedNames = result.packages
      .filter(p => !p.success)
      .map(p => p.packageName)
      .join(', ')
      this.log(errorBox('Bootstrap Failed', {
        'Failed Packages': failedNames,
        'Target Org': ctx.targetOrg,
      }))
      this.error(`Install failed for: ${failedNames}`, {exit: 2})
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
