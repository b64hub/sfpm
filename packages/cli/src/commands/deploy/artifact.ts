import {
  InstallationMode, InstallationSource, InstallOrchestrator, type TestLevel,
} from '@b64hub/sfpm-core'
import {Flags} from '@oclif/core'

import Deploy from './index.js'

export default class DeployArtifact extends Deploy {
  static override description = 'deploy one or more packages from built artifacts using source-deploy'
  static override flags = {
    ...Deploy.flags,
    'installation-key': Flags.string({char: 'k', description: 'installation key for unlocked packages'}),
  }

  public override async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(DeployArtifact)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    const ctx = await this.setupDeployContext(packages, flags)

    const orchestrator = new InstallOrchestrator(
      ctx.projectConfig,
      ctx.projectGraph,
      {
        force: flags.force,
        includeDependencies: !flags['no-dependencies'],
        mode: InstallationMode.SourceDeploy,
        source: InstallationSource.Artifact,
        targetOrg: flags['target-org'],
        versionInstall: flags['installation-key'] ? {installationKeys: {'*': flags['installation-key']}} : undefined,
      },
      ctx.logger,
    );

    const renderer = this.createRenderer(ctx.mode, flags['target-org'])
    renderer.attachTo(orchestrator as any)

    await this.runOrchestrator(orchestrator, ctx.resolvedPackages, renderer, flags)
  }
}
