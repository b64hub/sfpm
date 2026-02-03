import { Args, Flags } from '@oclif/core'
import { PackageInstaller, ProjectService, Logger, InstallationSource, InstallationMode } from '@b64/sfpm-core'
import { InstallProgressRenderer, OutputMode } from '../ui/install-progress-renderer.js'
import SfpmCommand from '../sfpm-command.js'

export default class Install extends SfpmCommand {
  static override description = 'install one or more packages'

  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --quiet',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --json',
    '<%= config.bin %> <%= command.id %> package-a package-b -o my-sandbox',
  ]

  static override args = {
    packages: Args.string({
      required: true,
      description: 'package(s) to install',
    }),
  }

  static override flags = {
    'target-org': Flags.string({ char: 'o', description: 'target org username', required: true }),
    'installation-key': Flags.string({ char: 'k', description: 'installation key for unlocked packages' }),
    'source': Flags.string({ 
      char: 's',
      description: 'installation source: local (project source) or artifact',
      options: ['local', 'artifact'],
    }),
    'force-mode': Flags.string({
      description: 'force installation mode for unlocked packages (source-deploy or version-install)',
      options: ['source-deploy', 'version-install'],
    }),
    force: Flags.boolean({ char: 'f', description: 'force reinstall even if already installed' }),
    quiet: Flags.boolean({ char: 'q', description: 'only show errors', exclusive: ['json'] }),
    json: Flags.boolean({ description: 'output as JSON for CI/CD', exclusive: ['quiet'] }),
  }

  static override strict = false

  public async execute(): Promise<void> {
    const { args, argv, flags } = await this.parse(Install)

    // Get package names from arguments - use argv for multiple packages
    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // Warn if multiple packages provided (not yet supported)
    if (packages.length > 1) {
      this.warn(`Multiple packages provided, but currently only installing the first: ${packages[0]}`)
      this.warn(`Future support will install: ${packages.join(', ')}`)
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

    // Create package installer
    const installer = new PackageInstaller(projectConfig, {
      targetOrg: flags['target-org'],
      installationKey: flags['installation-key'],
      source: flags['source'] as InstallationSource | undefined,
      mode: flags['force-mode'] as InstallationMode | undefined,
      force: flags.force,
    }, logger);

    // Create and attach progress renderer
    const renderer = new InstallProgressRenderer({
      logger: {
        log: (msg: string) => this.log(msg),
        error: (msgOrError: string | Error) => this.error(msgOrError),
      },
      mode,
    });
    renderer.attachTo(installer);

    // Execute installation
    try {
      await installer.installPackage(packageName);

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
      
      // Re-throw with original error for better debugging
      if (error instanceof Error) {
        // Show the actual error message, not just the wrapper
        const errorMessage = error.message || String(error);
        this.log(`\nError details: ${errorMessage}`);
        if (error.stack) {
          this.debug(`Stack trace: ${error.stack}`);
        }
        this.error(errorMessage, { exit: 2 });
      } else {
        throw error;
      }
    }
  }
}
