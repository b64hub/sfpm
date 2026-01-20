import EventEmitter from "node:events";
import { PackageType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Builder, BuilderRegistry } from "./builders/builder-registry.js";
import SfpmPackage from "./sfpm-package.js";
import PackageAssembler from "./assemblers/package-assembler.js";
import { SfpmPackageMetadata, SfpmPackageSource } from "../types/package.js";

import { Logger } from "../types/logger.js";

export interface BuildOptions {
    orgDefinitionFilePath?: string;
    buildNumber?: string;
}

export interface BuildEvents { }

export interface PreBuildTask { }

export interface PostBuildTask { }

export interface PropertyFetcher {
    getProperties(sfpmPackage: SfpmPackage): Promise<void>;
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

        if (this.options.orgDefinitionFilePath) {
            sfpmPackage.orgDefinitionFilePath = this.options.orgDefinitionFilePath;
        }

        if (this.sourceContext) {
            sfpmPackage.metadata.source = this.sourceContext;
        }

        await this.fetchProperties(sfpmPackage);
        await this.stagePackage(sfpmPackage);
        await this.convertToMetadataApiFormat(sfpmPackage);
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

    private async stagePackage(sfpmPackage: SfpmPackage): Promise<string> {
        const stagingDirectory = await new PackageAssembler(this.projectConfig, sfpmPackage.packageName)
            .withVersion(sfpmPackage.version)
            .withOrgDefinition(sfpmPackage.orgDefinitionFilePath)
            .withDestructiveManifest(sfpmPackage.metadata.content?.destructiveChangesPath)
            .assemble();

        return stagingDirectory;
    }



    private async convertToMetadataApiFormat(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        let sourceToMdapiConvertor = new SourceToMDAPIConvertor(
            sfpmPackage.workingDirectory,
            sfpmPackage.packageDefinition.path,
            ProjectConfig.getSFDXProjectConfig(sfpmPackage.workingDirectory).sourceApiVersion,
            this.logger
        );
        sfpmPackage.metadata.content.payload = (await sourceToMdapiConvertor.convert()).packagePath;
        const packageManifest: PackageManifest = await PackageManifest.create(sfpmPackage.metadata.content.payload);

        sfpmPackage.metadata.content.payload = packageManifest.manifestJson;
        sfpmPackage.metadata.content.apex.triggers = packageManifest.fetchTriggers();
        // and so on... need to check actual properties on sfpmPackage

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

    private async getComponentSet(sfpmPackage: SfpmPackage): Promise<ComponentSet> {
        return ComponentSet.fromSource({
            sourceDirectory: sfpmPackage.workingDirectory,
            ignore: sfpmPackage.packageDescriptor.ignore
        });
    }

    private async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        let analyzers = AnalyzerRegistry.getAnalyzers();
        for (const analyzer of analyzers) {
            if (analyzer.isEnabled(sfpmPackage, this.logger)) sfpmPackage = await analyzer.analyze(sfpmPackage, componentSet, this.logger);
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