import {
  InstallationSource, InstallEventBus, InstallOrchestrationTask, InstallOrchestrator, LifecycleEngine, Logger,
  type ProjectDefinitionProvider, type ProjectGraph, ProjectService, type TestLevel,
} from '@b64hub/sfpm-core'
import {Args, Flags} from '@oclif/core'
import {ConfigAggregator} from '@salesforce/core'
// Register SFDMU data installer (side-effect import triggers decorator registration)
import '@b64hub/sfpm-sfdmu'

import SfpmCommand from '../../sfpm-command.js'
import {InstallProgressRenderer, OutputMode} from '../../ui/install-progress-renderer.js'
import {resolvePackageInputs} from '../../utils/package-resolver.js'

export interface DeployContext {
  flags: Record<string, any>;
  logger: Logger;
  mode: OutputMode;
  projectConfig: ProjectDefinitionProvider;
  projectGraph: ProjectGraph;
  resolvedPackages: string[];
}

export default class Deploy extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to deploy',
      required: true,
    }),
  }
  static override description = 'deploy one or more packages from local project source'
  /**
   * Lifecycle stage: **deploy**
   *
   * Operations executed per package:
   * - `install:pre`  — before each package deployment starts
   * - `install:post` — after each package deployment succeeds
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --quiet',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --json',
    '<%= config.bin %> <%= command.id %> package-a package-b -o my-sandbox',
  ]
  static override flags = {
    force: Flags.boolean({char: 'f', description: 'force deploy even if already installed'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    'no-dependencies': Flags.boolean({description: 'only deploy the specified packages, skip transitive dependencies'}),
    'no-hooks': Flags.boolean({description: 'skip lifecycle hooks'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'target-org': Flags.string({
      char: 'o',
      description: 'target org username',
      env: 'SF_TARGET_ORG',
    }),
    'test-level': Flags.string({
      char: 'l', description: 'deployment test level', options: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'],
    }),
    turbo: Flags.boolean({description: 'single-package mode for external orchestrators (implies --no-dependencies --force)'}),
  }
  static override strict = false

  protected createRenderer(mode: OutputMode, targetOrg: string): InstallProgressRenderer {
    return new InstallProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
      targetOrg,
    });
  }

  public async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(this.constructor as typeof Deploy)

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

    const ctx = await this.setupDeployContext(packages, flags)

    // Single-package mode: deploy exactly one package without orchestration.
    // Activates when a single package is specified with --no-dependencies.
    // Designed for external orchestrators (Turbo, CI matrix) that handle
    // dependency ordering themselves.
    if (packages.length === 1 && flags['no-dependencies']) {
      await this.executeSinglePackage(ctx)
      return
    }

    await this.executeOrchestrated(ctx)
  }

  protected async executeOrchestrated(ctx: DeployContext): Promise<void> {
    const {flags, logger, mode, projectConfig, projectGraph, resolvedPackages} = ctx

    const orchestrator = InstallOrchestrator.forSource(
      projectConfig,
      projectGraph,
      {
        deployment: flags['test-level'] ? {testLevel: flags['test-level'] as TestLevel} : undefined,
        force: flags.force,
        includeDependencies: !flags['no-dependencies'],
        targetOrg: flags['target-org'],
      },
      logger,
    );

    const renderer = this.createRenderer(mode, flags['target-org'])
    renderer.attachTo(orchestrator.installBus, orchestrator.orchestrationBus)

    await this.runOrchestrator(orchestrator, resolvedPackages, renderer, flags)
  }

  protected async runOrchestrator(
    orchestrator: InstallOrchestrator,
    resolvedPackages: string[],
    renderer: InstallProgressRenderer,
    flags: Record<string, any>,
  ): Promise<void> {
    try {
      const result = await orchestrator.installAll(resolvedPackages)

      if (flags.json) {
        this.logJson(result)
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ')
        this.error(`Deploy failed for: ${failedNames}`, {exit: 2})
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

  protected async setupDeployContext(packages: string[], flags: Record<string, any>): Promise<DeployContext> {
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();

    // Resolve target org: flag > env > sf config default
    if (!flags['target-org']) {
      const configAggregator = await ConfigAggregator.create();
      flags['target-org'] = configAggregator.getPropertyValue<string>('target-org') ?? undefined;
    }

    if (!flags['target-org']) {
      this.error('A target org is required. Specify one with --target-org (-o) or set a default with: sf config set target-org=<username>', {exit: 1});
    }

    const resolvedPackages = await resolvePackageInputs(packages, projectConfig, {json: flags.json})

    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    const sfpmConfig = projectService.getSfpmConfig();

    if (!flags['no-hooks']) {
      const lifecycle = LifecycleEngine.stage('deploy');
      for (const hooks of sfpmConfig.hooks ?? []) {
        lifecycle.use(hooks);
      }
    }

    return {
      flags, logger: this.sfpmLogger, mode, projectConfig, projectGraph, resolvedPackages,
    }
  }

  private async executeSinglePackage(ctx: DeployContext): Promise<void> {
    const {flags, logger, mode, projectConfig, resolvedPackages} = ctx

    const installOptions = {
      deployment: flags['test-level'] ? {testLevel: flags['test-level'] as TestLevel} : undefined,
      force: flags.force,
      source: InstallationSource.Local,
      targetOrg: flags['target-org'],
    }

    const installBus = new InstallEventBus()
    const task = new InstallOrchestrationTask(
      projectConfig,
      installOptions,
      logger,
      installBus,
    )

    const renderer = this.createRenderer(mode, flags['target-org'])
    renderer.attachTo(installBus)

    try {
      const context = await task.setup()
      const result = await task.processSinglePackage(resolvedPackages[0], 0, context)

      if (flags.json) {
        this.logJson(result)
      }

      if (!result.success) {
        this.error(`Deploy failed for: ${resolvedPackages[0]}${result.error ? ` — ${result.error}` : ''}`, {exit: 2})
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
