import {
  InstallationMode, InstallationSource, InstallOrchestrationTask, InstallOrchestrator, LifecycleEngine, Logger, PackageInstaller, ProjectService,
} from '@b64/sfpm-core'
import {Args, Flags} from '@oclif/core'
import EventEmitter from 'node:events'
// Register SFDMU data installer (side-effect import triggers decorator registration)
import '@b64/sfpm-sfdmu'

import SfpmCommand from '../sfpm-command.js'
import {InstallProgressRenderer, OutputMode} from '../ui/install-progress-renderer.js'

export default class Install extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to install',
      required: true,
    }),
  }
  static override description = 'install one or more packages'
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
    mode: Flags.string({
      char: 'm',
      description: 'installation mode for unlocked packages (source-deploy or version-install)',
      options: ['source-deploy', 'version-install'],
    }),
    'no-dependencies': Flags.boolean({description: 'only install the specified packages, skip transitive dependencies'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    single: Flags.boolean({description: 'install a single package without orchestration (for use with external orchestrators like Turbo)'}),
    source: Flags.string({
      char: 's',
      description: 'installation source: local (project source) or artifact',
      options: ['local', 'artifact'],
    }),
    'target-org': Flags.string({
      char: 'o', description: 'target org username', env: 'SF_TARGET_ORG', required: true,
    }),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(Install)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // Use SFPM_PROJECT_DIR env var if set (for debugging from different directory), otherwise use cwd
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getProjectConfig();
    const projectGraph = projectService.getProjectGraph();

    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

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
    const lifecycle = new LifecycleEngine({logger, stage: 'local'});
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    const installOptions = {
      force: flags.force,
      installationKey: flags['installation-key'],
      mode: flags.mode as InstallationMode | undefined,
      source: flags.source as InstallationSource | undefined,
      targetOrg: flags['target-org'],
      trackHistory: sfpmConfig.artifacts?.trackHistory,
    }

    const renderer = new InstallProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
      targetOrg: flags['target-org'],
    });

    // --single mode: install exactly one package without orchestration.
    // Designed for external orchestrators (Turbo, CI matrix) that handle
    // dependency ordering themselves.
    if (flags.single) {
      if (packages.length !== 1) {
        this.error('--single mode requires exactly one package name', {exit: 1})
      }

      const task = new InstallOrchestrationTask(
        projectConfig,
        installOptions,
        logger,
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
          this.error(`Install failed for: ${packages[0]}${result.error ? ` — ${result.error}` : ''}`, {exit: 2})
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

    const orchestrator = new InstallOrchestrator(
      projectConfig,
      projectGraph,
      {...installOptions, includeDependencies: !flags['no-dependencies']},
      logger,
      lifecycle,
    )

    // Attach renderer to orchestrator — it forwards all installer events
    renderer.attachTo(orchestrator as any)

    try {
      const result = await orchestrator.installAll(packages)

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
