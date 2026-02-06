import { Command, Flags, ux, Args } from '@oclif/core'
import { PackageBuilder, ProjectService, Logger } from '@b64/sfpm-core'
import { BuildProgressRenderer, OutputMode } from '../ui/build-progress-renderer.js'
import SfpmCommand from '../sfpm-command.js'

export default class Build extends SfpmCommand {
  static override description = 'build one or more packages'

  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --quiet',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --json',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --force',
    '<%= config.bin %> <%= command.id %> package-a package-b -v my-devhub',
  ]

  static override args = {
    packages: Args.string({
      required: true,
      description: 'package(s) to build',
    }),
  }

  static override flags = {
    'target-dev-hub': Flags.string({ char: 'v', description: 'target dev hub username' }),
    'build-number': Flags.string({ char: 'b', description: 'build number' }),
    'installation-key': Flags.string({ char: 'k', description: 'installation key' }),
    'installation-key-bypass': Flags.boolean({ description: 'bypass installation key' }),
    'skip-validation': Flags.boolean({ description: 'skip validation' }),
    force: Flags.boolean({ char: 'f', description: 'build even if no source changes detected' }),
    tag: Flags.string({ char: 't', description: 'tag for the build' }),
    quiet: Flags.boolean({ char: 'q', description: 'only show errors', exclusive: ['json'] }),
    json: Flags.boolean({ description: 'output as JSON for CI/CD', exclusive: ['quiet'] }),
  }

  static override strict = false

  public async execute(): Promise<void> {
    const { args, argv, flags } = await this.parse(Build)

    // Get package names from arguments - use argv for multiple packages
    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // Warn if multiple packages provided (not yet supported)
    if (packages.length > 1) {
      this.warn(`Multiple packages provided, but currently only building the first: ${packages[0]}`)
      this.warn(`Future support will build: ${packages.join(', ')}`)
    }

    const packageName = packages[0]

    const projectService = await ProjectService.getInstance(process.cwd());

    const projectConfig = projectService.getProjectConfig();

    // Determine output mode
    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    // Create logger for audit trail (separate from UI events)
    const logger: Logger = {
      log: (msg: string) => this.log(msg),
      info: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
      error: (msg: string) => this.error(msg),
      debug: (msg: string) => this.debug(msg),
      trace: (msg: string) => this.debug(msg),
    }

    // Create package builder
    const builder = new PackageBuilder(projectConfig, {
      buildNumber: flags['build-number'],
      devhubUsername: flags['target-dev-hub'],
      installationKey: flags['installation-key'],
      installationKeyBypass: flags['installation-key-bypass'],
      isSkipValidation: flags['skip-validation'],
      force: flags.force,
    }, logger);

    // Create and attach progress renderer
    const renderer = new BuildProgressRenderer({
      logger: {
        log: (msg: string) => this.log(msg),
        error: (msgOrError: string | Error) => this.error(msgOrError),
      },
      mode,
    });
    renderer.attachTo(builder);

    // Execute build
    try {
      await builder.buildPackage(packageName);

      // Output JSON if requested
      if (flags.json) {
        this.logJson(renderer.getJsonOutput());
      }
    } catch (error) {
      renderer.handleError(error as Error);
      
      // Output JSON even on error if requested
      if (flags.json) {
        this.logJson(renderer.getJsonOutput());
      }
      
      throw error;
    }
  }
}
