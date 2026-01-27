import path from 'path';
import fs from 'fs-extra';

import { Org, SfProject, Lifecycle } from '@salesforce/core';
import { Duration } from '@salesforce/kit';
import { PackageVersion, PackageVersionCreateRequestResult } from '@salesforce/packaging';

import { Builder, RegisterBuilder } from './builder-registry.js';
import { BuildTask, BuildOptions } from '../package-builder.js';
import SfpmPackage, { SfpmUnlockedPackage } from '../sfpm-package.js';
import { PackageType, SfpmUnlockedPackageBuildOptions } from '../../types/package.js';
import ProjectService from '../../project/project-service.js';

import AssembleArtifactTask from './tasks/assemble-artifact-task.js';
import GitTagTask from './tasks/git-tag-task.js';

import { Logger } from '../../types/logger.js';

export interface UnlockedPackageBuilderOptions extends BuildOptions {
    isOrgDependentPackage: boolean;
    isSkipValidation: boolean;
}

@RegisterBuilder(PackageType.Unlocked)
export default class UnlockedPackageBuilder implements Builder {
    private workingDirectory: string;
    private sfpmPackage: SfpmUnlockedPackage;

    private devhubOrg?: Org;

    public preBuildTasks: BuildTask[] = [];
    public postBuildTasks: BuildTask[] = [];

    private logger?: Logger;

    constructor(workingDirectory: string, sfpmPackage: SfpmPackage, logger?: Logger) {
        if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
            throw new Error(
                `UnlockedPackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`,
            );
        }
        this.workingDirectory = workingDirectory;
        this.sfpmPackage = sfpmPackage;
        this.logger = logger;

        this.postBuildTasks.push(new AssembleArtifactTask(this.sfpmPackage, this.workingDirectory));
        this.postBuildTasks.push(new GitTagTask(this.sfpmPackage, this.workingDirectory));
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
            await task.exec();
        }
    }

    private async runPostBuildTasks(): Promise<void> {
        for (const task of this.postBuildTasks) {
            await task.exec();
        }
    }

    private async buildPackage(): Promise<void> {
        const sfProject = await SfProject.resolve(this.workingDirectory);

        // Get build options from package metadata
        const buildOptions = this.sfpmPackage.metadata.orchestration.buildOptions as SfpmUnlockedPackageBuildOptions;
        const waitTime = Duration.minutes(buildOptions?.waitTime || 120);
        const pollingFrequency = Duration.seconds(30);

        // Setup lifecycle listener for progress logging
        const lifecycle = Lifecycle.getInstance();
        const progressListener = async (data: PackageVersionCreateRequestResult) => {
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

            this.logger?.info(`Package Result: ${JSON.stringify(result)}`);

            if (result.SubscriberPackageVersionId) {
                this.sfpmPackage.packageVersionId = result.SubscriberPackageVersionId;
                // Update other metadata if available in result
                if (result.Status === 'Success') {
                    // We could fetch more info here if needed
                }
            } else {
                throw new Error(`Package creation failed or timed out. Status: ${result.Status}`);
            }

            // Coverage check
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
            // Clean up listener to avoid leaks
            lifecycle.removeAllListeners('packageVersionCreate:progress');
        }
    }

    /**
     * @description: cleanup sfpm constructs in working directory
     * // TODO move to assembly
     */
    private async pruneOrgDependentPackage(): Promise<void> {
        if (!this.sfpmPackage.isOrgDependent) {
            return;
        }

        const projectConfig = ProjectService.getInstance(this.workingDirectory).getProjectConfig();
        const prunedDefinition = projectConfig.getPrunedDefinition(this.sfpmPackage.packageName, {
            removeCustomProperties: true,
            isOrgDependent: this.sfpmPackage.isOrgDependent,
        });

        await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), prunedDefinition, { spaces: 4 });
    }
}
