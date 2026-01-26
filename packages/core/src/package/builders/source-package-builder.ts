import { Builder, RegisterBuilder } from "./builder-registry.js";
import { BuildTask } from "../package-builder.js";
import { PackageType } from "../../types/package.js";
import SfpmPackage, { SfpmSourcePackage } from "../sfpm-package.js";
import { Logger } from "../../types/logger.js";

export interface SourcePackageBuilderOptions {
}

@RegisterBuilder(PackageType.Source)
export default class SourcePackageBuilder implements Builder {
    private workingDirectory: string;
    private sfpmPackage: SfpmSourcePackage;
    private logger?: Logger;

    private preBuildTasks: BuildTask[] = [];
    private postBuildTasks: BuildTask[] = [];

    constructor(
        workingDirectory: string,
        sfpmPackage: SfpmPackage,
        logger?: Logger,
    ) {
        if (!(sfpmPackage instanceof SfpmSourcePackage)) {
            throw new Error(`SourcePackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
        }
        this.workingDirectory = workingDirectory;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;
    }

    public async exec(): Promise<void> {
        await this.runPreBuildTasks();
        await this.buildPackage();
        await this.runPostBuildTasks();
    }

    public async connect(username: string): Promise<void> {
        return Promise.resolve();
    }

    public async runPreBuildTasks() {
        return Promise.resolve();
    }

    public async runPostBuildTasks() {
        return Promise.resolve();
    }

    public async buildPackage() {
        this.handleApexTestClasses(this.sfpmPackage);
    }


    private handleApexTestClasses(sfpmPackage: SfpmSourcePackage) {
        if (sfpmPackage.hasApex && sfpmPackage.testClasses.length == 0) {
            sfpmPackage.isTriggerAllTests = true;
        }
    }
}
