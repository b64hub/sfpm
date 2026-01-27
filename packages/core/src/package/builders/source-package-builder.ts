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

    public preBuildTasks: BuildTask[] = [];
    public postBuildTasks: BuildTask[] = [];

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
        for (const task of this.preBuildTasks) {
            await task.exec();
        }
    }

    public async runPostBuildTasks() {
        for (const task of this.postBuildTasks) {
            await task.exec();
        }
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
