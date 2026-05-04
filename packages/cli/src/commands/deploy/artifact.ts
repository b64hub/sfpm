import {
  InstallationMode, InstallationSource, InstallOrchestrator, LifecycleEngine, Logger, ProjectService,
} from '@b64/sfpm-core'
import {Args, Flags} from '@oclif/core'
// Register SFDMU data installer (side-effect import triggers decorator registration)
import '@b64/sfpm-sfdmu'

import SfpmCommand from '../../sfpm-command.js'
import {InstallProgressRenderer, OutputMode} from '../../ui/install-progress-renderer.js'

export default class DeployArtifact extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to deploy',
      required: true,
    }),
  }
  static override description = 'deploy one or more packages from built artifacts using source-deploy'
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --quiet',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --json',
    '<%= config.bin %> <%= command.id %> package-a package-b -o my-sandbox',
  ]
  static override flags = {
    force: Flags.boolean({char: 'f', description: 'force deploy even if already installed'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key for unlocked packages'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    'no-dependencies': Flags.boolean({description: 'only deploy the specified packages, skip transitive dependencies'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'target-org': Flags.string({
      char: 'o', description: 'target org username', env: 'SF_TARGET_ORG', required: true,
    }),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(DeployArtifact)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
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

    const lifecycle = new LifecycleEngine({logger, stage: 'local'});
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    const renderer = new InstallProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode,
      targetOrg: flags['target-org'],
    });

    const orchestrator = new InstallOrchestrator(
      projectConfig,
      projectGraph,
      {
        force: flags.force,
        includeDependencies: !flags['no-dependencies'],
        installationKey: flags['installation-key'],
        mode: InstallationMode.SourceDeploy,
        source: InstallationSource.Artifact,
        targetOrg: flags['target-org'],
        trackHistory: sfpmConfig.artifacts?.trackHistory,
      },
      logger,
      lifecycle,
    );

    renderer.attachTo(orchestrator as any)

    try {
      const result = await orchestrator.installAll(packages)

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
}
