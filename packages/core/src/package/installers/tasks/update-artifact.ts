import { InstallTask, InstallTaskContext } from '../installer-registry.js';
import PackageManager from '../../package-manager.js';

export default class UpdateArtifactTask implements InstallTask {
  public name = 'update-artifact';

  public constructor(private ctx: InstallTaskContext) {}

  public async exec(): Promise<void> {
    const {targetOrg, logger} = this.ctx;

    const artifactService = PackageManager.getInstance(targetOrg, logger).getArtifactService();

    await artifactService.upsertArtifact(this.ctx.sfpmPackage);
    await artifactService.createHistoryRecord(this.ctx.sfpmPackage, {
        deployId: this.ctx.installId,
    });
  }
}