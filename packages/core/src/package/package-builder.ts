import EventEmitter from "node:events";
import * as _ from "lodash";

import { PackageType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Builder, BuilderRegistry } from "./builders/builder-registry.js";
import { AnalyzerRegistry } from "./analyzers/analyzer-registry.js";
import SfpmPackage, { PackageFactory } from "./sfpm-package.js";
import PackageAssembler from "./assemblers/package-assembler.js";
import { GitService } from "../git/git-service.js";

import { Logger } from "../types/logger.js";


export interface BuildOptions {
    buildNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
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
    private gitService?: GitService;

    constructor(projectConfig: ProjectConfig, options?: BuildOptions, logger?: Logger, gitService?: GitService) {
        super();
        this.options = options || {};
        this.logger = logger;
        this.projectConfig = projectConfig;
        this.gitService = gitService;
    }

    /**
     * @description Build a package and its un-built dependencies in the project
     * 
     */
    public async build(): Promise<void> { }


    /**
     * @description Build a single package by name
     * @param packageName 
     * @param projectDirectory 
     * @returns 
     */
    public async buildPackage(
        packageName: string,
        projectDirectory: string = process.cwd()
    ) {
        // Use PackageFactory to create a fully-configured package
        const packageFactory = new PackageFactory(this.projectConfig);
        const sfpmPackage = packageFactory.createFromName(packageName);

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

        // Set source context from git repository
        if (!this.gitService) {
            this.gitService = await GitService.initialize(projectDirectory, this.logger);
        }
        sfpmPackage.metadata.source = await this.gitService.getPackageSourceContext();

        // Apply orchestration options - each package type handles its own options
        sfpmPackage.setOrchestrationOptions({
            installationkey: this.options.installationKey,
            installationkeybypass: this.options.installationKeyBypass,
            isSkipValidation: this.options.isSkipValidation,
        });

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