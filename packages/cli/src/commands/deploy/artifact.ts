import {
  InstallOrchestrator, PackageOrigin, type TestLevel,
} from '@b64hub/sfpm-core'
import {Flags} from '@oclif/core'
import {Org} from '@salesforce/core'

import Deploy from './index.js'

export default class DeployArtifact extends Deploy {
  static override description = 'deploy one or more packages from built artifacts using source-deploy'
  static override flags = {
    ...Deploy.flags,
  }

  public override async execute(): Promise<void> {
    const {args, argv, flags} = await this.parse(DeployArtifact)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    const ctx = await this.setupDeployContext(packages, flags)

    const targetOrg = await Org.create({aliasOrUsername: flags['target-org']!})

    const orchestrator = new InstallOrchestrator(
      targetOrg,
      ctx.projectConfig,
      ctx.projectGraph,
      {
        force: flags.force,
        includeDependencies: !flags['no-dependencies'],
        origin: PackageOrigin.Artifact,
        unlocked: {sourceOnly: true},
      },
      ctx.logger,
    );

    const renderer = this.createRenderer(ctx.mode, flags['target-org']!)
    renderer.attachTo(orchestrator.installBus, orchestrator.orchestrationBus)

    await this.runOrchestrator(orchestrator, ctx.resolvedPackages, renderer, flags)
  }
}
