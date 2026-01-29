import EventEmitter from "node:events";
import { merge } from "lodash-es";

import { PackageType } from "../types/package.js";
import ProjectConfig from "../project/project-config.js";
import { Builder, BuilderRegistry } from "./builders/builder-registry.js";
import { AnalyzerRegistry } from "./analyzers/analyzer-registry.js";
import SfpmPackage, { PackageFactory } from "./sfpm-package.js";
import PackageAssembler from "./assemblers/package-assembler.js";
import { GitService } from "../git/git-service.js";

import { Logger } from "../types/logger.js";
import { AllBuildEvents } from "../types/events.js";


export interface BuildOptions {
    buildNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    devhubUsername?: string;
    installationKey?: string;
    installationKeyBypass?: boolean;
    isSkipValidation?: boolean;
}

export interface BuildTask { 
    exec(): Promise<void>;
}

/**
 * Orchestrator for package builds
 */
export class PackageBuilder extends EventEmitter<AllBuildEvents> {
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

        // Emit build start event
        this.emit('build:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            packageType: sfpmPackage.type as PackageType,
            buildNumber: this.options.buildNumber,
            version: sfpmPackage.version,
        });

        // Merge build options from package definition
        if (sfpmPackage.packageDefinition?.packageOptions?.build) {
            merge(sfpmPackage.metadata.orchestration, {
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

        try {
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

            // Emit connection start if connecting to dev hub
            if (this.options.devhubUsername) {
                this.emit('connection:start', {
                    timestamp: new Date(),
                    packageName: sfpmPackage.packageName,
                    username: this.options.devhubUsername,
                    orgType: 'devhub',
                });
                
                await builderInstance.connect(this.options.devhubUsername);
                
                this.emit('connection:complete', {
                    timestamp: new Date(),
                    packageName: sfpmPackage.packageName,
                    username: this.options.devhubUsername,
                });
            }

            // Emit builder start
            this.emit('builder:start', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                packageType: sfpmPackage.type as PackageType,
                builderName: BuilderClass.name,
            });

            // Bubble up events from builder if it's an EventEmitter
            if (builderInstance instanceof EventEmitter) {
                this.bubbleEvents(builderInstance);
            }

            const result = await builderInstance.exec();

            // Emit builder complete
            this.emit('builder:complete', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                packageType: sfpmPackage.type as PackageType,
                builderName: BuilderClass.name,
            });

            // Emit build complete
            this.emit('build:complete', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                success: true,
                packageVersionId: 'packageVersionId' in sfpmPackage ? (sfpmPackage.packageVersionId as string) : undefined,
            });

            return result;
        } catch (error: any) {
            // Determine phase based on error context
            let phase: 'staging' | 'analysis' | 'connection' | 'build' | 'post-build' = 'build';
            if (error.message?.includes('staged')) phase = 'staging';
            if (error.message?.includes('analyzer')) phase = 'analysis';
            if (error.message?.includes('connect')) phase = 'connection';
            if (error.message?.includes('no metadata components')) phase = 'staging';

            this.emit('build:error', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                error,
                phase,
            });

            throw error;
        }
    }

    public async stagePackage(sfpmPackage: SfpmPackage): Promise<void> {
        this.emit('stage:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            stagingDirectory: sfpmPackage.stagingDirectory,
        });

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

        this.emit('stage:complete', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            stagingDirectory: assemblyOutput.stagingDirectory,
            componentCount: assemblyOutput.componentCount || 0,
        });

        return;
    }


    public async runAnalyzers(sfpmPackage: SfpmPackage): Promise<void> {
        if (sfpmPackage.type === PackageType.Data) {
            return;
        }

        let analyzers = AnalyzerRegistry.getAnalyzers(this.logger);
        const enabledAnalyzers = analyzers.filter(a => a.isEnabled(sfpmPackage));

        this.emit('analyzers:start', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            analyzerCount: enabledAnalyzers.length,
        });

        for (const analyzer of enabledAnalyzers) {
            const analyzerName = analyzer.constructor.name;
            
            this.emit('analyzer:start', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                analyzerName,
            });

            const metadataContribution = await analyzer.analyze(sfpmPackage);
            merge(sfpmPackage.metadata, metadataContribution);

            this.emit('analyzer:complete', {
                timestamp: new Date(),
                packageName: sfpmPackage.packageName,
                analyzerName,
                findings: metadataContribution,
            });
        }

        this.emit('analyzers:complete', {
            timestamp: new Date(),
            packageName: sfpmPackage.packageName,
            completedCount: enabledAnalyzers.length,
        });
    }

    /**
     * Bubble up events from builder instances to PackageBuilder
     */
    private bubbleEvents(builderInstance: EventEmitter): void {
        // Define which events to bubble up
        const eventsToBubble = [
            'unlocked:prune:start',
            'unlocked:prune:complete',
            'unlocked:create:start',
            'unlocked:create:progress',
            'unlocked:create:complete',
            'unlocked:validation:start',
            'unlocked:validation:complete',
            'source:assemble:start',
            'source:assemble:complete',
            'source:test:start',
            'source:test:complete',
            'task:start',
            'task:complete',
        ];

        eventsToBubble.forEach(eventName => {
            builderInstance.on(eventName, (...args: any[]) => {
                this.emit(eventName as any, ...args);
            });
        });
    }
}