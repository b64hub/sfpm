import { Builder, RegisterBuilder } from "./builder-registry.js";
import { BuildTask, BuildOptions } from "../package-builder.js";
import { SfpmUnlockedPackage } from "../sfpm-package.js";
import { PackageType } from "../../types/package.js";
import { Logger } from "../../types/logger.js";

import { Org } from "@salesforce/core";
import { Connection } from "@salesforce/core";
import path from "path";

export interface UnlockedPackageBuilderOptions extends BuildOptions {
    isOrgDependentPackage: boolean;
    isSkipValidation: boolean;
}


@RegisterBuilder(PackageType.Unlocked)
export default class UnlockedPackageBuilder implements Builder {

    private workingDirectory: string;
    private sfpmPackage: SfpmUnlockedPackage;

    private devhubOrg?: Org;

    private preBuildTasks: BuildTask[] = [];
    private postBuildTasks: BuildTask[] = [];

    private logger?: Logger;

    constructor(workingDirectory: string, sfpmPackage: SfpmUnlockedPackage, logger?: Logger) {
        this.workingDirectory = workingDirectory;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;
    }

    public async exec(): Promise<void> {
        if (!this.devhubOrg) {
            throw new Error('Must run connect() before exec()');
        }

        await this.runPreBuildTasks();
        await this.buildPackage();
        await this.runPostBuildTasks();
    }

    public async connect(username: string): Promise<void> {
        this.devhubOrg = await Org.create({ aliasOrUsername: username })
        if (!this.devhubOrg.getConnection()) {
            throw new Error('Unable to connect to org');
        }
    }

    private async runPreBuildTasks(): Promise<void> {

        if (this.sfpmPackage.stagingDirectory) {
            this.workingDirectory = this.sfpmPackage.stagingDirectory;
        }

        this.cleanup();

        //Resolve the package dependencies
        if (this.isOrgDependentPackage) {
            // Store original dependencies to artifact
            sfpPackage.dependencies = sfpPackage.packageDescriptor['dependencies'];

        } else if (!this.isOrgDependentPackage && !this.packageCreationParams.isSkipValidation) {

            sfpPackage.packageDescriptor = ProjectConfig.getSFDXPackageDescriptor(
                this.workingDirectory,
                this.sfpPackage.packageName
            );
            //Store the resolved dependencies
            sfpPackage.dependencies = sfpPackage.packageDescriptor['dependencies'];

        } else {

            sfpPackage.dependencies = sfpPackage.packageDescriptor['dependencies'];
        }

        //Print Dependencies
        PackageDependencyDisplayer.printPackageDependencies(sfpPackage.dependencies, sfpPackage.projectConfig, this.logger);

        return Promise.resolve();
    }

    private runPostBuildTasks(): Promise<void> {
        return Promise.resolve();
    }

    private buildPackage(): Promise<void> {
        return Promise.resolve();
    }

    /**
     * /cleanup sfpm constructs in working directory
     */
    private async cleanup(): Promise<void> {


    }



}
