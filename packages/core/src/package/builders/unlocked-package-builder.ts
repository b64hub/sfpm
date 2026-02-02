import path from 'path';
import fs from 'fs-extra';
import EventEmitter from 'node:events';

import { Org, SfProject, Lifecycle } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { PackageVersion, PackageVersionCreateRequestResult } from '@salesforce/packaging';

import { Builder, RegisterBuilder } from './builder-registry.js';
import { BuildTask, BuildOptions } from '../package-builder.js';
import SfpmPackage, { SfpmUnlockedPackage } from '../sfpm-package.js';
import { PackageType, SfpmUnlockedPackageBuildOptions } from '../../types/package.js';
import ProjectService from '../../project/project-service.js';
import { UnlockedBuildEvents } from '../../types/events.js';

import AssembleArtifactTask, { AssembleArtifactTaskOptions } from './tasks/assemble-artifact-task.js';
import GitTagTask from './tasks/git-tag-task.js';
import SourceHashTask from './tasks/source-hash-task.js';

import { Logger } from '../../types/logger.js';

export interface UnlockedPackageBuilderOptions extends BuildOptions {
    isOrgDependentPackage: boolean;
    isSkipValidation: boolean;
}

@RegisterBuilder(PackageType.Unlocked)
export default class UnlockedPackageBuilder extends EventEmitter<UnlockedBuildEvents> implements Builder {
    private workingDirectory: string;
    private sfpmPackage: SfpmUnlockedPackage;

    private devhubOrg?: Org;

    public preBuildTasks: BuildTask[] = [];
    public postBuildTasks: BuildTask[] = [];

    private logger?: Logger;

    constructor(workingDirectory: string, sfpmPackage: SfpmPackage, logger?: Logger) {
        super();
        if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
            throw new Error(
                `UnlockedPackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`,
            );
        }
        this.workingDirectory = workingDirectory;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;

        // Use project directory for artifacts, not the staging directory
        const projectDir = this.sfpmPackage.projectDirectory;
        
        // Get npm scope from project definition - throw if not configured
        const npmScope = this.getNpmScope();
        const assembleOptions: AssembleArtifactTaskOptions = { npmScope };

        this.preBuildTasks.push(new SourceHashTask(this.sfpmPackage, projectDir, this.logger));
        this.postBuildTasks.push(new AssembleArtifactTask(this.sfpmPackage, projectDir, assembleOptions));
        this.postBuildTasks.push(new GitTagTask(this.sfpmPackage, projectDir));
    }

    /**
     * Get npm scope from project definition.
     * @throws Error if npm scope is not configured
     */
    private getNpmScope(): string {
        const projectDef = this.sfpmPackage.projectDefinition;
        const npmScope = projectDef?.plugins?.sfpm?.npmScope;
        
        if (!npmScope) {
            throw new Error(
                'npm scope not configured. Add plugins.sfpm.npmScope to sfdx-project.json (e.g., "@myorg")'
            );
        }
        
        return npmScope;
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
        this.devhubOrg = await Org.create({ aliasOrUsername: username });
        if (!this.devhubOrg.isDevHubOrg()) {
            throw new Error('Must connect to a dev hub org');
        }

        if (!this.devhubOrg.getConnection()) {
            throw new Error('Unable to connect to org');
        }
    }

    private async runPreBuildTasks(): Promise<void> {
        if (this.sfpmPackage.stagingDirectory) {
            this.workingDirectory = this.sfpmPackage.stagingDirectory;
        }

        await this.pruneOrgDependentPackage();

        const allDependencies = await ProjectService.getPackageDependencies(this.sfpmPackage.name);

        for (const task of this.preBuildTasks) {
            const taskName = task.constructor.name;
            
            this.emit('task:start', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                taskName,
                taskType: 'pre-build',
            });

            try {
                await task.exec();
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'pre-build',
                    success: true,
                });
            } catch (error) {
                const success = error instanceof Error && (error as any).code === 'BUILD_NOT_REQUIRED';
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'pre-build',
                    success,
                });
                
                throw error;
            }
        }
    }

    private async runPostBuildTasks(): Promise<void> {
        for (const task of this.postBuildTasks) {
            const taskName = task.constructor.name;
            
            this.emit('task:start', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                taskName,
                taskType: 'post-build',
            });

            try {
                await task.exec();
                
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'post-build',
                    success: true,
                });
            } catch (error) {
                this.emit('task:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    taskName,
                    taskType: 'post-build',
                    success: false,
                });
                
                throw error;
            }
        }
    }

    private async buildPackage(): Promise<void> {
        const sfProject = await SfProject.resolve(this.workingDirectory);

        // Get build options from package metadata
        const buildOptions = this.sfpmPackage.metadata.orchestration.buildOptions as SfpmUnlockedPackageBuildOptions;
        const waitTime = Duration.minutes(buildOptions?.waitTime || 120);
        const pollingFrequency = Duration.seconds(30);

        // Emit create start event
        this.emit('unlocked:create:start', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            packageId: this.sfpmPackage.packageId,
            versionNumber: this.sfpmPackage.version || '',
        });

        // Setup lifecycle listener for progress logging
        const lifecycle = Lifecycle.getInstance();
        const progressListener = async (data: PackageVersionCreateRequestResult) => {
            // Emit progress event
            this.emit('unlocked:create:progress', {
                timestamp: new Date(),
                packageName: this.sfpmPackage.packageName,
                status: data.Status,
                message: data.Status,
            });

            if (this.logger) {
                this.logger.info(`Status: ${data.Status}, Next Status check in ${pollingFrequency.seconds} seconds`);
                if (data.Error?.length) {
                    this.logger.error(`Creation errors: ${data.Error.join('\n')}`);
                }
            }
        };

        lifecycle.on('packageVersionCreate:progress', progressListener);

        try {
            const result = await PackageVersion.create(
                {
                    connection: this.devhubOrg!.getConnection() as any,
                    project: sfProject as any,
                    installationkey: buildOptions?.installationkey,
                    installationkeybypass: buildOptions?.installationkeybypass,
                    tag: this.sfpmPackage.metadata.source?.tag,
                    skipvalidation: buildOptions?.isSkipValidation,
                    asyncvalidation: buildOptions?.isAsyncValidation,
                    postinstallscript: buildOptions?.postInstallScript,
                    codecoverage: buildOptions?.isCoverageEnabled,
                    versionnumber: this.sfpmPackage.version,
                    definitionfile: buildOptions?.configFilePath
                        ? path.join(this.workingDirectory, buildOptions.configFilePath)
                        : undefined,
                    packageId: this.sfpmPackage.packageId,
                },
                { timeout: waitTime, frequency: pollingFrequency },
            );

            // Result details are emitted via events for structured handling
            this.logger?.debug(`Package Result: ${JSON.stringify(result)}`);

            if (result.SubscriberPackageVersionId) {
                this.sfpmPackage.packageVersionId = result.SubscriberPackageVersionId;
                
                // Update the package version with the actual version number (including build number)
                // This ensures artifact folders and git tags use the complete version (e.g., 1.1.0-1 instead of 1.1.0.NEXT)
                if (result.VersionNumber) {
                    this.sfpmPackage.version = result.VersionNumber;
                    this.logger?.debug(`Updated package version to ${result.VersionNumber}`);
                }
                
                // Emit create complete event with detailed result information
                this.emit('unlocked:create:complete', {
                    timestamp: new Date(),
                    packageName: this.sfpmPackage.packageName,
                    packageVersionId: result.SubscriberPackageVersionId,
                    versionNumber: result.VersionNumber || this.sfpmPackage.version || '',
                    subscriberPackageVersionId: result.SubscriberPackageVersionId,
                    packageId: result.Package2Id,
                    status: result.Status,
                    codeCoverage: result.CodeCoverage ?? undefined,
                    hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
                    totalNumberOfMetadataFiles: result.TotalNumberOfMetadataFiles ?? undefined,
                    totalSizeOfMetadataFiles: result.TotalSizeOfMetadataFiles ?? undefined,
                    hasMetadataRemoved: result.HasMetadataRemoved ?? undefined,
                    createdDate: result.CreatedDate,
                });
                
                // Update other metadata if available in result
                if (result.Status === 'Success') {
                    // We could fetch more info here if needed
                }
            } else {
                throw new Error(`Package creation failed or timed out. Status: ${result.Status}`);
            }

            if (
                buildOptions?.isCoverageEnabled &&
                !this.sfpmPackage.isOrgDependent &&
                !buildOptions?.isAsyncValidation
            ) {
                if (!result.HasPassedCodeCoverageCheck) {
                    throw new Error('This package has not meet the minimum coverage requirement of 75%');
                }
            }
        } catch (error: any) {
            throw new Error(`Unable to create ${this.sfpmPackage.packageName}: ${error.message}`);
        } finally {
            lifecycle.removeAllListeners('packageVersionCreate:progress');
        }
    }

    /**
     * @description: cleanup sfpm constructs in working directory
     */
    private async pruneOrgDependentPackage(): Promise<void> {
        if (!this.sfpmPackage.isOrgDependent) {
            return;
        }

        this.emit('unlocked:prune:start', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            reason: 'Org-dependent package requires pruning',
        });

        const projectConfig = (await ProjectService.getInstance(this.workingDirectory)).getProjectConfig();
        const prunedDefinition = projectConfig.getPrunedDefinition(this.sfpmPackage.packageName, {
            removeCustomProperties: true,
            isOrgDependent: this.sfpmPackage.isOrgDependent,
        });

        await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), prunedDefinition, { spaces: 4 });

        this.emit('unlocked:prune:complete', {
            timestamp: new Date(),
            packageName: this.sfpmPackage.packageName,
            prunedFiles: 1,
        });
    }
}
