import EventEmitter from "node:events";
import { PackageType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Builder, BuilderRegistry } from "./builders/builder-registry.js";
import { AnalyzerRegistry } from "./analyzers/analyzer-registry.js";
import SfpmPackage from "./sfpm-package.js";
import PackageAssembler from "./assemblers/package-assembler.js";
import { AssemblyOutput } from "./assemblers/types.js";
import { SfpmPackageMetadata, SfpmPackageSource } from "../types/package.js";

import { Logger } from "../types/logger.js";

export interface BuildOptions {
    buildNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
}

export interface BuildEvents { }

export interface PreBuildTask { }

export interface PostBuildTask { }

export interface PropertyFetcher {
    getProperties(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageMetadata>>;
}

/**
 * Orchestrator for package builds
 */
export class PackageBuilder extends EventEmitter<BuildEvents> {
    private options: BuildOptions;
    private logger: Logger | undefined;
    private projectConfig: ProjectConfig;

    private sourceContext?: SfpmPackageSource;

    private preBuildTasks: PreBuildTask[] = [];
    private postBuildTasks: PostBuildTask[] = [];

    private propertyFetchers: PropertyFetcher[] = [
        new AssignPermissionSetFetcher(),
        new DestructiveManifestPathFetcher(),
        new ReconcilePropertyFetcher(),
    ];

    constructor(projectConfig: ProjectConfig, options?: BuildOptions, logger?: Logger) {
        super();
        this.options = options || {};
        this.logger = logger;
        this.projectConfig = projectConfig;
    }

    public setSourceContext(sourceContext: SfpmPackageSource): void {
        this.sourceContext = sourceContext;
    }

    public async build(): Promise<void> { }

    private async buildPackage(
        packageName: string,
        workingDirectory?: string
    ) {

        await this.projectConfig.load();

        let sfpmPackage: SfpmPackage = new SfpmPackage(
            packageName,
            workingDirectory || process.cwd(),
        );
        this.setPackageIdentity(sfpmPackage);

        sfpmPackage.projectDefinition = this.projectConfig.getProjectDefinition();
        sfpmPackage.packageDefinition = this.projectConfig.getPackageDefinition(packageName);

        if (this.options.orgDefinitionPath) {
            sfpmPackage.orgDefinitionFilePath = this.options.orgDefinitionPath;
        }

        if (this.sourceContext) {
            sfpmPackage.metadata.source = this.sourceContext;
        }

        await this.fetchProperties(sfpmPackage);
        const assemblyOutput = await this.stagePackage(sfpmPackage);
        sfpmPackage.workingDirectory = assemblyOutput.stagingDirectory;
        sfpmPackage.mdapiDir = assemblyOutput.metadataApiResult?.packagePath;

        await this.fetchApexTypes(sfpmPackage);
        await this.runAnalyzers(sfpmPackage);

        const BuilderClass = BuilderRegistry.getBuilder(sfpmPackage.type);

        if (!BuilderClass) {
            throw new Error(`No builder registered for package type: ${sfpmPackage.type}`);
        }

        const builderInstance: Builder = new BuilderClass(
            sfpmPackage.workingDirectory,
            sfpmPackage.metadata
        );

        return builderInstance.exec();
    }

    private setPackageIdentity(sfpmPackage: SfpmPackage): void {
        this.setPackageVersion(sfpmPackage, this.options.buildNumber);

        sfpmPackage.metadata.identity.packageType = this.projectConfig.getPackageType(sfpmPackage.packageName);
        sfpmPackage.metadata.identity.apiVersion = this.projectConfig.sourceApiVersion;
        sfpmPackage.metadata.identity.versionNumber = sfpmPackage.version;
    }

    private async fetchProperties(sfpmPackage: SfpmPackage): Promise<void> {
        for (const propertyFetcher of this.propertyFetchers) {
            await propertyFetcher.getProperties(sfpmPackage);
        }
    }

    private async stagePackage(sfpmPackage: SfpmPackage): Promise<AssemblyOutput> {
        const assemblyOutput = await new PackageAssembler({
            projectConfig: this.projectConfig,
            packageName: sfpmPackage.packageName,
        })
            .withVersion(sfpmPackage.version)
            .withOrgDefinition(this.options.orgDefinitionPath)
            .withDestructiveManifest(this.options.destructiveManifestPath)
            .assemble();

        return assemblyOutput;
    }

    private async fetchApexTypes(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        let apexFetcher: ApexTypeFetcher = new ApexTypeFetcher(sfpmPackage.workingDirectory);
        sfpmPackage.metadata.content.apex.classes = apexFetcher.getClassesClassifiedByType();
        // ...
        sfpmPackage.metadata.validation.isTriggerAllTests = this.isAllTestsToBeTriggered(sfpmPackage, this.logger);

    }

    private async getComponentSet(sfpmPackage: SfpmPackage): Promise<any> {
        return (global as any).ComponentSet?.fromSource({
            sourceDirectory: sfpmPackage.workingDirectory,
            ignore: sfpmPackage.packageDefinition?.ignore
        });
    }

    private async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        const componentSet = await this.getComponentSet(sfpmPackage);

        let analyzers = AnalyzerRegistry.getAnalyzers(this.logger);
        for (const analyzer of analyzers) {
            if (analyzer.isEnabled(sfpmPackage)) {
                sfpmPackage = await analyzer.analyze(sfpmPackage, componentSet);
            }
        }
    }


    /*
     *  Handle version Numbers of package
     *  If VersionNumber is explcitly passed, use that
     *  else allow autosubstitute using buildNumber for Source and Data if available
     */
    private setPackageVersion(sfpmPackage: SfpmPackage, buildNumber?: string): void {
        if (sfpmPackage.version && buildNumber && sfpmPackage.type !== PackageType.Unlocked) {
            const segments = sfpmPackage.version.split('.');
            const numberToBeAppended = parseInt(buildNumber);

            if (isNaN(numberToBeAppended)) {
                throw new Error('BuildNumber should be a number');
            }

            segments[3] = buildNumber;
            sfpmPackage.version = segments.join('.');
            return;
        }

        if (sfpmPackage.packageDefinition?.versionNumber) {
            sfpmPackage.version = sfpmPackage.packageDefinition.versionNumber;
            return;
        }

        throw new Error('The package doesnt have a version attribute, Please check your definition');
    }
}