import EventEmitter from "node:events";
import * as _ from "lodash";

import { PackageType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Builder, BuilderRegistry } from "./builders/builder-registry.js";
import { AnalyzerRegistry } from "./analyzers/analyzer-registry.js";
import SfpmPackage, { SfpmMetadataPackage, SfpmDataPackage, SfpmSourcePackage, SfpmUnlockedPackage } from "./sfpm-package.js";
import PackageAssembler from "./assemblers/package-assembler.js";
import { SfpmPackageSource } from "../types/package.js";

import { Logger } from "../types/logger.js";


export interface BuildOptions {
    buildNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    sourceContext?: SfpmPackageSource;
    devhubUsername?: string;
    installationKey?: string;
    installationKeyBypass?: boolean;
    isSkipValidation?: boolean;
}

export interface BuildEvents { }

export interface BuildTask { 
    exec(): Promise<void>;
}

/**
 * Orchestrator for package builds
 */
export class PackageBuilder extends EventEmitter<BuildEvents> {
    private options: BuildOptions;
    private logger: Logger | undefined;
    private projectConfig: ProjectConfig;

    constructor(projectConfig: ProjectConfig, options?: BuildOptions, logger?: Logger) {
        super();
        this.options = options || {};
        this.logger = logger;
        this.projectConfig = projectConfig;
    }


    public async build(): Promise<void> { }

    public async buildPackage(
        packageName: string,
        projectDirectory: string = process.cwd()
    ) {

        await this.projectConfig.load();
        const packageDefinition = this.projectConfig.getPackageDefinition(packageName);
        const packageType = packageDefinition?.type || PackageType.Unlocked;

        let sfpmPackage: SfpmPackage;

        if (packageType === PackageType.Unlocked) {
            sfpmPackage = new SfpmUnlockedPackage(packageName, projectDirectory);
        } else if (packageType === PackageType.Source) {
            sfpmPackage = new SfpmSourcePackage(packageName, projectDirectory);
        } else if (packageType === PackageType.Data) {
            sfpmPackage = new SfpmDataPackage(packageName, projectDirectory);
        } else {
            sfpmPackage = new SfpmMetadataPackage(packageName, projectDirectory);
        }

        sfpmPackage.projectDefinition = this.projectConfig.getProjectDefinition();
        sfpmPackage.packageDefinition = packageDefinition;

        // Merge build options from package definition
        if (sfpmPackage.packageDefinition?.packageOptions?.build) {
            _.merge(sfpmPackage.metadata.orchestration, {
                buildOptions: sfpmPackage.packageDefinition.packageOptions.build
            });
        }

        if (this.options.buildNumber) {
            sfpmPackage.setBuildNumber(this.options.buildNumber);
        }

        if (this.options.orgDefinitionPath) {
            sfpmPackage.orgDefinitionPath = this.options.orgDefinitionPath;
        }

        if (this.options.sourceContext) {
            sfpmPackage.metadata.source = this.options.sourceContext;
        }

        // Apply overrides from options
        if (this.options.installationKey) {
            _.set(sfpmPackage.metadata, 'orchestration.buildOptions.installationkey', this.options.installationKey);
        }
        if (this.options.installationKeyBypass) {
            _.set(sfpmPackage.metadata, 'orchestration.buildOptions.installationkeybypass', this.options.installationKeyBypass);
        }
        if (this.options.isSkipValidation !== undefined) {
            _.set(sfpmPackage.metadata, 'orchestration.buildOptions.isSkipValidation', this.options.isSkipValidation);
        }


        await this.stagePackage(sfpmPackage);
        await this.runAnalyzers(sfpmPackage);

        if (!sfpmPackage.stagingDirectory) {
            throw new Error('Package must be staged for build');
        }

        const BuilderClass = BuilderRegistry.getBuilder(sfpmPackage.type);

        if (!BuilderClass) {
            throw new Error(`No builder registered for package type: ${sfpmPackage.type}`);
        }

        const builderInstance: Builder = new BuilderClass(
            sfpmPackage.stagingDirectory,
            sfpmPackage,
            this.logger
        );

        if (this.options.devhubUsername) {
            await builderInstance.connect(this.options.devhubUsername);
        }

        return builderInstance.exec();
    }

    public async stagePackage(sfpmPackage: SfpmPackage): Promise<void> {
        const assemblyOutput = await new PackageAssembler(
            sfpmPackage.packageName,
            this.projectConfig,
            {
                versionNumber: sfpmPackage.version,
                orgDefinitionPath: this.options.orgDefinitionPath,
                destructiveManifestPath: this.options.destructiveManifestPath,
            },
            this.logger
        ).assemble();

        sfpmPackage.stagingDirectory = assemblyOutput.stagingDirectory;
        return;
    }


    public async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        let analyzers = AnalyzerRegistry.getAnalyzers(this.logger);
        for (const analyzer of analyzers) {
            if (analyzer.isEnabled(sfpmPackage)) {
                const metadataContribution = await analyzer.analyze(sfpmPackage);
                _.merge(sfpmPackage.metadata, metadataContribution);
            }
        }
    }
}