import type {SfpmPackageSource} from '../../../types/artifact.js';

import PackageManager from '../../package-manager.js';
import {InstallTask, InstallTaskContext} from '../installer-registry.js';

export default class UpdateArtifactTask implements InstallTask {
  public name = 'update-artifact';

  public constructor(private ctx: InstallTaskContext) {}

  public async exec(): Promise<void> {
    const {logger, sfpmPackage, targetOrg} = this.ctx;

    const artifactService = PackageManager.getInstance(targetOrg, logger).getArtifactService();

    // Only sourceHash is available at install time (commit/branch/tag require
    // a git checkout, which artifact-provider installs from node_modules don't have).
    const source: SfpmPackageSource | undefined = sfpmPackage.sourceHash
      ? {sourceHash: sfpmPackage.sourceHash}
      : undefined;

    await artifactService.upsertArtifact(sfpmPackage, source);
    await artifactService.createHistoryRecord(sfpmPackage, {
      deployId: this.ctx.installId,
    }, source);
  }
}
