import {
  BuildOrchestrationTask, BuildOrchestrator, LifecycleEngine, Logger, ProjectService,
} from '@b64/sfpm-core'
import {
  Args, Flags,
} from '@oclif/core'
import {ConfigAggregator} from '@salesforce/core'
import EventEmitter from 'node:events'
// Register SFDMU data builder (side-effect import triggers decorator registration)
import '@b64/sfpm-sfdmu'

import SfpmCommand from '../sfpm-command.js'
import {BuildProgressRenderer, OutputMode} from '../ui/build-progress-renderer.js'

export default class Build extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to build',
      required: true,
    }),
  }
  static override description = 'build one or more packages'
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --quiet',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --json',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --force',
    '<%= config.bin %> <%= command.id %> package-a package-b -v my-devhub',
  ]
  static override flags = {
    'build-number': Flags.string({char: 'b', description: 'build number'}),
    force: Flags.boolean({char: 'f', description: 'build even if no source changes detected', env: 'SFPM_FORCE_BUILD'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    'no-dependencies': Flags.boolean({default: false, description: 'build the specified packages without their transitive dependencies'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    single: Flags.boolean({description: 'build a single package without orchestration (for use with external orchestrators like Turbo)'}),
    'skip-validation': Flags.boolean({description: 'skip validation'}),
    tag: Flags.string({char: 't', description: 'tag for the build'}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target dev hub username', env: 'SF_DEV_HUB'}),
    wait: Flags.integer({
      char: 'w', default: 120, description: 'timeout in minutes for package version creation', min: 1,
    }),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(Build)

    // Get package names from arguments - use argv for multiple packages
    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // Use SFPM_PROJECT_DIR env var if set (for debugging from different directory), otherwise use cwd
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);

    const projectConfig = projectService.getProjectConfig();
    const projectGraph = projectService.getProjectGraph();

    // Determine output mode
    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    // Create logger for audit trail (separate from UI events)
    const logger: Logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }

    const sfpmConfig = projectService.getSfpmConfig();

    // Create lifecycle engine and register hooks from config
    const lifecycle = new LifecycleEngine({logger, stage: 'build'});
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    // Resolve devhub: use flag if provided, otherwise fall back to SF CLI default
    let devhubUsername = flags['target-dev-hub']
    if (!devhubUsername) {
      const configAggregator = await ConfigAggregator.create()
      devhubUsername = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined
    }

    if (!devhubUsername) {
      this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1})
    }

    const buildOptions = {
      buildNumber: flags['build-number'],
      devhubUsername,
      force: flags.force,
      ignoreFilesConfig: sfpmConfig.ignoreFiles,
      installationKey: flags['installation-key'],
      isSkipValidation: flags['skip-validation'],
      waitTime: flags.wait,
    }

    // Create and attach progress renderer
    const renderer = new BuildProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
    });

    // --single mode: build exactly one package without orchestration.
    // Designed for external orchestrators (Turbo, CI matrix) that handle
    // dependency ordering and parallelism themselves.
    if (flags.single) {
      if (packages.length !== 1) {
        this.error('--single mode requires exactly one package name', {exit: 1})
      }

      const task = new BuildOrchestrationTask(
        projectConfig,
        buildOptions,
        logger,
        projectDir,
        lifecycle,
      )

      const emitter = new EventEmitter()
      renderer.attachTo(emitter as any)

      try {
        const context = await task.setup()
        const result = await task.processSinglePackage(packages[0], 0, context, emitter)

        if (flags.json) {
          this.logJson(result)
        }

        if (!result.success) {
          this.error(`Build failed for: ${packages[0]}${result.error ? ` — ${result.error}` : ''}`, {exit: 1})
        }
      } catch (error) {
        renderer.handleError(error as Error)
        if (flags.json) {
          this.logJson({error: (error as Error).message, success: false})
        }

        throw error
      }

      return
    }

    const orchestrator = new BuildOrchestrator(
      projectConfig,
      projectGraph,
      {...buildOptions, includeDependencies: !flags['no-dependencies']},
      logger,
      projectDir,
      lifecycle,
    )

    // Attach renderer to orchestrator — it forwards all builder events
    renderer.attachTo(orchestrator as any)

    try {
      const result = await orchestrator.buildAll(packages)

      if (flags.json) {
        this.logJson(result)
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ')
        this.error(`Build failed for: ${failedNames}`, {exit: 1})
      }
    } catch (error) {
      renderer.handleError(error as Error)
      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false})
      }

      throw error
    }
  }
}
