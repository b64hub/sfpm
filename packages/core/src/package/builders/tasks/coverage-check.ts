import { Org } from '@salesforce/core';

import PackageService, { Package2Version } from '../../package-service.js';
import { BuildTask } from '../../package-builder.js';
import SfpmPackage from '../../sfpm-package.js';

import { Logger } from '../../../types/logger.js';

export default class CoverageCheck implements BuildTask {
    public constructor(private org: Org, private logger: Logger) {}

    public async exec(sfpmPackage: SfpmPackage): Promise<void> {

        const package2Version: Package2Version = await new PackageService(this.org, this.logger).getPackageVersionBySubscriberId(sfpmPackage.packageVersionId);

        let packageCoverage = <PackageCoverage>{};

        if (!package2Version) {
            throw new Error(`Package version doesnot exist, Please check the version details`);
        }

        packageCoverage.HasPassedCodeCoverageCheck = package2Version.HasPassedCodeCoverageCheck;
        packageCoverage.coverage = package2Version.CodeCoverage ? package2Version.CodeCoverage.apexCodeCoveragePercentage : 0;
        packageCoverage.packageId = package2Version.Package2Id;
        packageCoverage.packageName = package2Version.Package2.Name;
        packageCoverage.packageVersionId = package2Version.SubscriberPackageVersionId;
        packageCoverage.packageVersionNumber = `${package2Version.MajorVersion}.${package2Version.MinorVersion}.${package2Version.PatchVersion}.${package2Version.BuildNumber}`;

        this.logger.info(`Successfully Retrieved the Apex Test Coverage of the package version`);
    }
}

interface PackageCoverage {
    coverage: number;
    packageName: string;
    packageId: string;
    packageVersionNumber: string;
    packageVersionId: string;
    HasPassedCodeCoverageCheck: boolean;
}
