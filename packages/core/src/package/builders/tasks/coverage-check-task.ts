import {Org} from '@salesforce/core';

import {Logger} from '../../../types/logger.js';
import PackageService, {Package2Version} from '../../package-service.js';
import SfpmPackage, {SfpmUnlockedPackage} from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';

export default class CoverageCheck implements BuildTask {
  public constructor(
    private sfpmPackage: SfpmUnlockedPackage,
    private org: Org,
    private logger: Logger,
  ) {}

  public async exec(): Promise<void> {
    if (!this.sfpmPackage.packageVersionId) {
      throw new Error('Package version id is not defined');
    }

    const package2Version: Package2Version = await new PackageService(
      this.org,
      this.logger,
    ).getPackageVersionBySubscriberId(this.sfpmPackage.packageVersionId);

    if (!package2Version) {
      throw new Error('Package version doesnot exist, Please check the version details');
    }

    if (!package2Version.HasPassedCodeCoverageCheck) {
      throw new Error(`Package version ${this.sfpmPackage.packageName}@${this.sfpmPackage.version} has not passed the code coverage check.`
        + ` It only has ${package2Version.CodeCoverage.apexCodeCoveragePercentage}% coverage`);
    }

    this.logger.info(`Package version ${this.sfpmPackage.packageName}@${this.sfpmPackage.version} has passed the code coverage check.`
      + ` It has ${package2Version.CodeCoverage.apexCodeCoveragePercentage}% coverage`);
  }
}
