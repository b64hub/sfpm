import { Command, Flags } from '@oclif/core'
import { PackageBuilder, ProjectService, Logger } from '@b64/sfpm-core'

export default class Build extends Command {
  static override description = 'build a package'

  static override examples = [
    '<%= config.bin %> <%= command.id %> -p my-package -v my-devhub',
  ]

  static override flags = {
    package: Flags.string({ char: 'p', description: 'package to build', required: true }),
    'target-dev-hub': Flags.string({ char: 'v', description: 'target dev hub username' }),
    'build-number': Flags.string({ char: 'b', description: 'build number' }),
    'installation-key': Flags.string({ char: 'k', description: 'installation key' }),
    'installation-key-bypass': Flags.boolean({ description: 'bypass installation key' }),
    'skip-validation': Flags.boolean({ description: 'skip validation' }),
    tag: Flags.string({ char: 't', description: 'tag for the build' }),
  }

  public async run(): Promise<void> {
    const { flags } = await this.parse(Build)

    const projectService = await ProjectService.getInstance(process.cwd());

    const projectConfig = projectService.getProjectConfig();

    const logger: Logger = {
      log: (msg: string) => this.log(msg),
      info: (msg: string) => this.log(msg),
      warn: (msg: string) => this.warn(msg),
      error: (msg: string) => this.error(msg),
      debug: (msg: string) => this.debug(msg),
      trace: (msg: string) => this.debug(msg),
    }

    const builder = new PackageBuilder(projectConfig, {
      buildNumber: flags['build-number'],
      devhubUsername: flags['target-dev-hub'],
      installationKey: flags['installation-key'],
      installationKeyBypass: flags['installation-key-bypass'],
      isSkipValidation: flags['skip-validation'],
      sourceContext: flags.tag ? { tag: flags.tag } : undefined,
    }, logger);

    await builder.buildPackage(flags.package);
  }
}
