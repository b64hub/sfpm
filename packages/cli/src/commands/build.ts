import {
  BuildOrchestrator, Logger, ProjectService,
} from '@b64/sfpm-core'
import {
  Args, Flags,
} from '@oclif/core'
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
    force: Flags.boolean({char: 'f', description: 'build even if no source changes detected'}),
    'include-dependencies': Flags.boolean({description: 'build the specified packages and their transitive dependencies'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'skip-validation': Flags.boolean({description: 'skip validation'}),
    tag: Flags.string({char: 't', description: 'tag for the build'}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target dev hub username'}),
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
    const buildOptions = {
      buildNumber: flags['build-number'],
      devhubUsername: flags['target-dev-hub'],
      force: flags.force,
      ignoreFilesConfig: sfpmConfig.ignoreFiles,
      installationKey: flags['installation-key'],
      isSkipValidation: flags['skip-validation'],
      npmScope: sfpmConfig.npmScope,
    }

    // Create and attach progress renderer
    const renderer = new BuildProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
    });

    const orchestrator = new BuildOrchestrator(
      projectConfig,
      projectGraph,
      {...buildOptions, includeDependencies: flags['include-dependencies']},
      logger,
      projectDir,
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
