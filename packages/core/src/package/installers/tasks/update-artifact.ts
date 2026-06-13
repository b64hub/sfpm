import { InstallTask, InstallTaskContext } from '../installer-registry.js';
import { ArtifactService } from '../../../artifacts/artifact-service.js';

export default class UpdateArtifactTask implements InstallTask {
  public name = 'update-artifact';

  public constructor(private ctx: InstallTaskContext) {}

  public async exec(): Promise<void> {
    const artifactService = ArtifactService.getInstance()
      .setOrg(this.ctx.targetOrg)
      .setLogger(this.ctx.logger);

    await artifactService.upsertArtifact(this.ctx.sfpmPackage);
    await artifactService.createHistoryRecord(this.ctx.sfpmPackage, {
        deployId: this.ctx.installId,
    });
  }
}