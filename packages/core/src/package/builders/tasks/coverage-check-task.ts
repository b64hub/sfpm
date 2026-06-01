import {Org} from '@salesforce/core';

import {Logger} from '../../../types/logger.js';
import PackageService, {Package2Version} from '../../package-service.js';
import {SfpmUnlockedPackage} from '../../sfpm-package.js';
import {BuildTask, BuildTaskContext} from '../builder-registry.js';

export interface CoverageCheckOptions {
  org: Org;
}

class CoverageCheck implements BuildTask {
  public readonly name = 'coverage-check';
  private readonly logger?: Logger;
  private readonly org: Org;
  private readonly sfpmPackage: SfpmUnlockedPackage;

  public constructor(ctx: BuildTaskContext, options: CoverageCheckOptions) {
    if (!(ctx.sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`CoverageCheck received incompatible package type: ${ctx.sfpmPackage.constructor.name}`);
    }

    this.sfpmPackage = ctx.sfpmPackage;
    this.org = options.org;
    this.logger = ctx.logger;
  }

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

    this.logger?.info(`Package version ${this.sfpmPackage.packageName}@${this.sfpmPackage.version} has passed the code coverage check.`
      + ` It has ${package2Version.CodeCoverage.apexCodeCoveragePercentage}% coverage`);
  }
}

/** Curried factory for CoverageCheck. */
export function coverageCheckTask(options: CoverageCheckOptions): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new CoverageCheck(ctx, options);
}

export default CoverageCheck;
