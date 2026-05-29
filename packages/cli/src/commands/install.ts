import {
  InstallEventBus,
  InstallOrchestrationTask, InstallOrchestrator, LifecycleEngine, ProjectService, type TestLevel,
} from '@b64hub/sfpm-core'
import {createTracer} from '@b64hub/sfpm-telemetry'
import {Args, Flags} from '@oclif/core'
// Register SFDMU data installer (side-effect import triggers decorator registration)
import '@b64hub/sfpm-sfdmu'

import SfpmCommand from '../sfpm-command.js'
import {InstallProgressRenderer, OutputMode} from '../ui/install-progress-renderer.js'
import {resolvePackageInputs} from '../utils/package-resolver.js'

export default class Install extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to install',
      required: true,
    }),
  }
  static override description = 'install one or more packages'
  /**
   * Lifecycle stage: **install**
   *
   * Operations executed per package:
   * - `install:pre`  — before each package installation starts
   * - `install:post` — after each package installation succeeds
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --quiet',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --json',
    '<%= config.bin %> <%= command.id %> package-a package-b -o my-sandbox',
  ]
  static override flags = {
    force: Flags.boolean({char: 'f', description: 'force reinstall even if already installed'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key for unlocked packages'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    'no-dependencies': Flags.boolean({description: 'only install the specified packages, skip transitive dependencies'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'target-org': Flags.string({
      char: 'o', description: 'target org username', env: 'SF_TARGET_ORG', required: true,
    }),
    'test-level': Flags.string({
      char: 'l', description: 'deployment test level (for source deployments)', options: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'],
    }),
    turbo: Flags.boolean({description: 'single-package mode for external orchestrators (implies --no-dependencies --force)'}),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(Install)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // --turbo: single-package mode for external orchestrators (Turbo, CI matrix)
    if (flags.turbo) {
      if (packages.length !== 1) {
        this.error('--turbo requires exactly one package name', {exit: 1})
      }

      flags['no-dependencies'] = true
      flags.force = true
    }

    // Use SFPM_PROJECT_DIR env var if set (for debugging from different directory), otherwise use cwd
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();

    // Resolve user input (scoped or unscoped) to canonical scoped package names
    const resolvedPackages = await resolvePackageInputs(packages, projectConfig, {json: flags.json})

    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    const sfpmConfig = projectService.getSfpmConfig();

    // Create lifecycle engine and register hooks from config
    const lifecycle = LifecycleEngine.stage('install');
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    const installOptions = {
      deployment: flags['test-level'] ? {testLevel: flags['test-level'] as TestLevel} : undefined,
      force: flags.force,
      targetOrg: flags['target-org'],
      versionInstall: flags['installation-key'] ? {installationKeys: {'*': flags['installation-key']}} : undefined,
    }

    const renderer = new InstallProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
      targetOrg: flags['target-org'],
    });

    // Single-package mode: install exactly one package without orchestration.
    // Activates when a single package is specified with --no-dependencies.
    // Designed for external orchestrators (Turbo, CI matrix) that handle
    // dependency ordering themselves.
    if (resolvedPackages.length === 1 && flags['no-dependencies']) {
      const installBus = new InstallEventBus()
      const task = new InstallOrchestrationTask(
        projectConfig,
        installOptions,
        this.sfpmLogger,
        installBus,
      )

      renderer.attachTo(installBus)

      try {
        const context = await task.setup()
        const result = await task.processSinglePackage(resolvedPackages[0], 0, context)

        if (flags.json) {
          this.logJson(result)
        }

        if (!result.success) {
          this.error(`Install failed for: ${resolvedPackages[0]}${result.error ? ` — ${result.error}` : ''}`, {exit: 2})
        }
      } catch (error) {
        renderer.handleError(error as Error)
        if (flags.json) {
          this.logJson({error: (error as Error).message, success: false})
        }

        if (error instanceof Error) {
          this.error(error.message, {exit: 2})
        }

        throw error
      }

      return
    }

    const orchestrator = InstallOrchestrator.forArtifact(
      projectConfig,
      projectGraph,
      {...installOptions, includeDependencies: !flags['no-dependencies']},
      this.sfpmLogger,
    )

    // Attach renderer to orchestrator buses
    renderer.attachTo(orchestrator.installBus, orchestrator.orchestrationBus)

    const tracer = createTracer({serviceName: 'sfpm-cli'})
    tracer.subscribe({install: orchestrator.installBus, orchestration: orchestrator.orchestrationBus})

    try {
      const result = await orchestrator.installAll(resolvedPackages)

      await tracer.shutdown()

      if (flags.json) {
        this.logJson(result)
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ')
        this.error(`Install failed for: ${failedNames}`, {exit: 2})
      }
    } catch (error) {
      renderer.handleError(error as Error)
      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false})
      }

      if (error instanceof Error) {
        this.error(error.message, {exit: 2})
      }

      throw error
    }
  }
}
