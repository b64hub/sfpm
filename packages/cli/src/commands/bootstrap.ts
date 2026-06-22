import {
  BuildOrchestrator,
  InstallOrchestrator,
  Logger,
  PackageCreator,
  PackageService,
  type ProjectDefinitionProvider,
  ProjectService,
  stripScope,
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
  type BootstrapAction,
  type BootstrapPackageConfig,
  type BootstrapPackageResult,
  type BootstrapResult,
  BootstrapTier,
  getPackagesForTier,
  resolveAction,
} from '../types/bootstrap.js'
import {
  errorBox, infoBox, successBox,
} from '../ui/boxes.js'
import {BuildProgressRenderer, OutputMode} from '../ui/build-progress-renderer.js'
import {connectDevHub} from '../ui/connect-devhub.js'
import {InstallProgressRenderer} from '../ui/install-progress-renderer.js'

const BOOTSTRAP_REPO = 'https://github.com/b64hub/sfpm-bootstrap'

const TIER_DESCRIPTIONS: Record<BootstrapTier, string> = {
  [BootstrapTier.Core]: 'sfpm-artifact only -- artifact tracking custom setting',
  [BootstrapTier.Full]: 'All packages -- adds artifact history & UI components',
  [BootstrapTier.Pool]: 'sfpm-artifact + sfpm-orgs -- adds scratch org & sandbox pooling',
}

/** Per-package status determined before the pipeline runs. */
interface PackageStatus {
  action: BootstrapAction;
  installedVersion?: string;
  latestReleasedVersion?: string;
  name: string;
  subscriberVersionId?: string;
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
    force: Flags.boolean({char: 'f', description: 'force rebuild, re-promote, and re-install all packages'}),
    'target-org': Flags.string({char: 'o', description: 'target org username (must also be a DevHub)', required: true}),
    tier: Flags.string({
      char: 't',
      description: 'package tier to install',
      options: ['core', 'pool', 'full'],
    }),
  }

  public async execute(): Promise<BootstrapResult | void> {
    const {flags} = await this.parse(Bootstrap)

    const ctx: BootstrapContext = {
      isInteractive: this.outputMode === 'interactive',
      logger: this.sfpmLogger,
      mode: this.outputMode,
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
      const {devhub: org} = await connectDevHub({
        alias: ctx.targetOrg,
        mode: ctx.mode,
        validate: [
          {
            label: 'Verifying DevHub status...',
            async run(devhub) {
              if (!await devhub.determineIfDevHubOrg()) {
                throw new Error(`The target org '${ctx.targetOrg}' is not a DevHub. `
                  + 'Bootstrap requires a DevHub org to create and build packages. '
                  + 'Enable DevHub in Setup > Dev Hub or use a different org.')
              }
            },
          },
        ],
      })

      // ── 1. Resolve per-package status ──────────────────────────────
      const statuses = await this.resolvePackageStatuses(org, selectedPackages, flags.force ?? false, ctx)

      // If everything is up-to-date, short-circuit
      if (statuses.every(s => s.action === 'skip')) {
        return this.handleAllUpToDate(statuses, tier, flags, ctx)
      }

      if (ctx.isInteractive) {
        this.logPackageStatuses(statuses)
      }

      // ── 2. Setup project for packages that need building ──────────
      const needsBuild = statuses.filter(s => s.action === 'build')
      const needsPromote = statuses.filter(s => s.action === 'promote')
      const needsInstall = statuses.filter(s => s.action === 'install' || s.action === 'build' || s.action === 'promote')
      const results: BootstrapPackageResult[] = statuses
      .filter(s => s.action === 'skip')
      .map(s => ({
        action: 'skip' as const, packageName: s.name, skipped: true, success: true, version: s.installedVersion,
      }))

      let projectService: ProjectService | undefined

      if (needsBuild.length > 0) {
        projectService = await ProjectService.create(tmpDir)
        const provider = projectService.getDefinitionProvider()
        await this.ensurePackageContainers(org, {
          ctx, packages: selectedPackages, provider, tmpDir,
        })
        projectService.syncSfdxProject()

        // ── 3. Build packages that need it ─────────────────────────
        const buildNames = needsBuild.map(s => s.name)
        const buildResult = await this.buildPackages(projectService, buildNames, flags.force ?? false, ctx)

        if (!buildResult.success) {
          for (const name of buildNames) {
            const failed = buildResult.failedPackages?.includes(name)
            if (failed) {
              results.push({
                action: 'build',
                error: 'Build failed',
                packageName: name,
                skipped: false,
                success: false,
              })
            }
          }
        }
      }

      // ── 4. Promote unpromoted versions (newly built + previously built but not promoted) ──
      const promoteNames = [
        ...needsBuild.map(s => s.name),
        ...needsPromote.map(s => s.name),
      ]
      if (promoteNames.length > 0) {
        const promoteResults = await this.promotePackages(org, promoteNames, ctx)
        for (const pr of promoteResults) {
          if (!pr.success) {
            results.push({
              action: 'promote',
              error: pr.error,
              packageName: pr.name,
              promoted: false,
              skipped: false,
              success: false,
            })
          }
        }
      }

      // ── 5. Install packages that need it ─────────────────────────
      // Only install packages that haven't already failed
      const failedNames = new Set(results.filter(r => !r.success).map(r => r.packageName))
      const installNames = needsInstall
      .map(s => s.name)
      .filter(name => !failedNames.has(name))

      if (installNames.length > 0) {
        if (!projectService) {
          projectService = await ProjectService.create(tmpDir)
        }

        const installResults = await this.installPackages(projectService, installNames, flags, ctx)
        for (const ir of installResults) {
          results.push(ir)
        }
      }

      return this.finalizeResult(results, tier, flags, ctx)
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
    force: boolean,
    ctx: BootstrapContext,
  ): Promise<{failedPackages?: string[]; success: boolean}> {
    if (ctx.isInteractive) {
      this.log(chalk.bold('\nBuilding packages...\n'))
    }

    const buildOrchestrator = new BuildOrchestrator(
      projectService.getDefinitionProvider(),
      projectService.getProjectGraph(),
      {
        devhubUsername: ctx.targetOrg, force, includeDependencies: true,
      },
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
    buildRenderer.attachTo(buildOrchestrator.buildBus, buildOrchestrator.orchestrationBus)

    const buildResult = await buildOrchestrator.buildAll(packageNames)

    return {
      failedPackages: buildResult.failedPackages,
      success: buildResult.success,
    }
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

  private async ensurePackageContainers(
    org: Org,
    options: {ctx: BootstrapContext; packages: BootstrapPackageConfig[]; provider: ProjectDefinitionProvider; tmpDir: string},
  ): Promise<void> {
    const creator = new PackageCreator(org, options.ctx.logger)
    await creator.ensurePackages(options.packages, options.provider, options.tmpDir, async name => {
      if (!options.ctx.isInteractive) return true
      return confirm({
        default: true,
        message: `Package '${name}' does not exist in the DevHub. Create it?`,
      })
    })
  }

  private finalizeResult(
    results: BootstrapPackageResult[],
    tier: BootstrapTier,
    flags: {force?: boolean; json?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): BootstrapResult | void {
    const result: BootstrapResult = {
      packages: results,
      success: results.every(r => r.success),
      targetOrg: ctx.targetOrg,
      tier,
    }

    if (this.outputMode !== 'json') {
      this.renderFinalResult(result, ctx)
    }

    return result
  }

  private handleAllUpToDate(
    statuses: PackageStatus[],
    tier: BootstrapTier,
    _flags: {force?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): BootstrapResult | void {
    const result: BootstrapResult = {
      packages: statuses.map(s => ({
        action: 'skip' as const,
        packageName: s.name,
        skipped: true,
        success: true,
        version: s.installedVersion,
      })),
      success: true,
      targetOrg: ctx.targetOrg,
      tier,
    }

    if (ctx.isInteractive) {
      this.log(successBox('All packages up-to-date', {
        Hint: 'Use --force to rebuild and re-install',
        Packages: statuses.map(s => `${stripScope(s.name)} (${s.installedVersion})`).join(', '),
        'Target Org': ctx.targetOrg,
      }))
    }

    return result
  }

  private async installPackages(
    projectService: ProjectService,
    packageNames: string[],
    flags: {force?: boolean; 'target-org': string},
    ctx: BootstrapContext,
  ): Promise<BootstrapPackageResult[]> {
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
    installRenderer.attachTo(installOrchestrator.installBus, installOrchestrator.orchestrationBus)

    const installResult = await installOrchestrator.installAll(packageNames)

    return installResult.results.map(p => ({
      action: 'install' as BootstrapAction,
      error: p.error,
      packageName: p.packageName,
      skipped: p.skipped,
      success: p.success,
    }))
  }

  private logPackageStatuses(statuses: PackageStatus[]): void {
    const lines: string[] = []
    for (const s of statuses) {
      const name = stripScope(s.name)
      switch (s.action) {
      case 'build': {
        lines.push(chalk.yellow(`  [build]   ${name}`))
        break
      }

      case 'install': {
        lines.push(chalk.blue(`  [install] ${name} (${s.latestReleasedVersion})`))
        break
      }

      case 'promote': {
        lines.push(chalk.magenta(`  [promote] ${name} (${s.latestReleasedVersion})`))
        break
      }

      case 'skip': {
        lines.push(chalk.dim(`  [skip]    ${name} (${s.installedVersion})`))
        break
      }
      }
    }

    this.log(`\n${lines.join('\n')}\n`)
  }

  private async promotePackages(
    org: Org,
    packageNames: string[],
    ctx: BootstrapContext,
  ): Promise<Array<{error?: string; name: string; success: boolean}>> {
    if (ctx.isInteractive) {
      this.log(chalk.bold('\nPromoting package versions...\n'))
    }

    const devhubService = new PackageService(org, ctx.logger)
    const results: Array<{error?: string; name: string; success: boolean}> = []

    // Pre-fetch all packages once to avoid repeated API calls
    const allPackages = await devhubService.listAllPackages()

    for (const name of packageNames) {
      const unscopedName = stripScope(name)
      let spinner: Ora | undefined
      if (ctx.isInteractive) {
        spinner = ora(`Promoting ${unscopedName}...`).start()
      }

      try {
        const pkg = allPackages.find(p => p.Name === unscopedName)
        if (!pkg) {
          const error = `Package "${unscopedName}" not found in DevHub`
          spinner?.fail(error)
          results.push({error, name, success: false})
          continue
        }

        // Get the latest non-released version (the one we just built)
        const versions = await devhubService.getPackage2VersionById(pkg.Id) // eslint-disable-line no-await-in-loop
        const unpromoted = versions.find(v => !v.IsReleased)

        if (!unpromoted) {
          // All versions are already promoted — nothing to do
          spinner?.succeed(`${unscopedName} -- already promoted`)
          results.push({name, success: true})
          continue
        }

        await devhubService.promoteVersion(unpromoted.SubscriberPackageVersionId) // eslint-disable-line no-await-in-loop
        spinner?.succeed(`${unscopedName} -- promoted (${unpromoted.SubscriberPackageVersionId})`)
        results.push({name, success: true})
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        spinner?.fail(`${unscopedName} -- promote failed: ${message}`)
        results.push({error: message, name, success: false})
        // Continue with next package — promotion can be retried on re-run
      }
    }

    return results
  }

  private renderFinalResult(result: BootstrapResult, ctx: BootstrapContext): void {
    if (!ctx.isInteractive) return

    if (result.success) {
      const details: Record<string, string> = {
        'Target Org': ctx.targetOrg,
        Tier: result.tier,
      }

      const installed = result.packages.filter(p => !p.skipped)
      if (installed.length > 0) {
        details.Installed = installed.map(p => p.packageName).join(', ')
      }

      const skipped = result.packages.filter(p => p.skipped)
      if (skipped.length > 0) {
        details.Skipped = skipped.map(p => p.packageName).join(', ')
      }

      this.log(successBox('Bootstrap Complete', details))
    } else {
      const failed = result.packages.filter(p => !p.success)
      this.log(errorBox('Bootstrap Failed', {
        'Failed Packages': failed.map(p => `${p.packageName}: ${p.error ?? 'unknown error'}`).join('\n'),
        Hint: 'Re-run the command to retry failed packages',
        'Target Org': ctx.targetOrg,
      }))
    }
  }

  /**
   * Resolve per-package action by comparing DevHub versions to what's installed.
   *
   * - skip:    installed version >= latest released version
   * - install: a released version exists that's newer than what's installed
   * - promote: an unreleased version exists (built but not promoted)
   * - build:   no version exists at all, or --force is set
   */
  private async resolvePackageStatuses(
    org: Org,
    selectedPackages: BootstrapPackageConfig[],
    force: boolean,
    ctx: BootstrapContext,
  ): Promise<PackageStatus[]> {
    let spinner: Ora | undefined
    if (ctx.isInteractive) {
      spinner = ora('Checking package versions...').start()
    }

    const devhubService = new PackageService(org, ctx.logger)
    const installed = await devhubService.getAllInstalled2GPPackages()
    const installedByName = new Map(installed.map(p => [p.name, p]))
    const allDevHubPackages = await devhubService.listAllPackages()

    const statuses: PackageStatus[] = []

    // Sequential: each package queried individually from DevHub
    for (const pkg of selectedPackages) {
      const unscopedName = stripScope(pkg.name)

      if (force) {
        statuses.push({action: 'build', name: pkg.name})
        continue
      }

      // Find the Package2 in the DevHub
      const devhubPkg = allDevHubPackages.find(p => p.Name === unscopedName)
      if (!devhubPkg) {
        statuses.push({
          action: resolveAction({
            force, hasPackage: false, hasReleasedVersions: false, hasUnreleasedVersions: false,
          }), name: pkg.name,
        })
        continue
      }

      // Get released versions
      // eslint-disable-next-line no-await-in-loop
      const releasedVersions = await devhubService.getPackage2VersionById(devhubPkg.Id, undefined, false, true)
      // Get all versions (to detect unreleased)
      const allVersions = releasedVersions.length === 0
        ? await devhubService.getPackage2VersionById(devhubPkg.Id) // eslint-disable-line no-await-in-loop
        : releasedVersions

      const latestReleased = releasedVersions[0]
      const latestVersion = latestReleased
        ? `${latestReleased.MajorVersion}.${latestReleased.MinorVersion}.${latestReleased.PatchVersion}.${latestReleased.BuildNumber}`
        : undefined

      const installedPkg = installedByName.get(unscopedName)

      const action = resolveAction({
        force,
        hasPackage: true,
        hasReleasedVersions: releasedVersions.length > 0,
        hasUnreleasedVersions: allVersions.length > 0 && releasedVersions.length === 0,
        installedVersion: installedPkg?.versionNumber,
        latestVersion,
      })

      const latest = latestReleased ?? allVersions[0]
      const versionStr = latest
        ? `${latest.MajorVersion}.${latest.MinorVersion}.${latest.PatchVersion}.${latest.BuildNumber}`
        : undefined

      statuses.push({
        action,
        installedVersion: installedPkg?.versionNumber,
        latestReleasedVersion: versionStr,
        name: pkg.name,
        subscriberVersionId: latest?.SubscriberPackageVersionId,
      })
    }

    const skipped = statuses.filter(s => s.action === 'skip').length
    const builds = statuses.filter(s => s.action === 'build').length
    const promotes = statuses.filter(s => s.action === 'promote').length
    const installs = statuses.filter(s => s.action === 'install').length
    spinner?.succeed(`Version check complete: ${skipped} up-to-date, ${builds} need build, ${promotes} need promote, ${installs} need install`)

    return statuses
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
