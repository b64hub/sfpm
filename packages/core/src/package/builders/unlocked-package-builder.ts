import {Lifecycle, Org, SfProject} from '@salesforce/core';
import {Duration} from '@salesforce/kit';
import {PackageVersion, PackageVersionCreateRequestResult} from '@salesforce/packaging';
import fs from 'fs-extra';
import EventEmitter from 'node:events';
import path from 'node:path';

import ProjectService from '../../project/project-service.js';
import {UnlockedBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType, SfpmUnlockedPackageBuildOptions} from '../../types/package.js';
import {BuildTask} from '../package-builder.js';
import SfpmPackage, {SfpmUnlockedPackage} from '../sfpm-package.js';
import {Builder, BuilderOptions, RegisterBuilder} from './builder-registry.js';
import AssembleArtifactTask, {AssembleArtifactTaskOptions} from './tasks/assemble-artifact-task.js';
import GitTagTask from './tasks/git-tag-task.js';
import SourceHashTask from './tasks/source-hash-task.js';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Unlocked)
export default class UnlockedPackageBuilder extends EventEmitter<UnlockedBuildEvents> implements Builder {
  public postBuildTasks: BuildTask[] = [];
  public preBuildTasks: BuildTask[] = [];
  private devhubOrg?: Org;
  private logger?: Logger;
  private options: BuilderOptions;
  private sfpmPackage: SfpmUnlockedPackage;
  private workingDirectory: string;

  constructor(workingDirectory: string, sfpmPackage: SfpmPackage, options: BuilderOptions, logger?: Logger) {
    super();
    if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`UnlockedPackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;

    // Use project directory for artifacts, not the staging directory
    const projectDir = this.sfpmPackage.projectDirectory;

    // Get npm scope from options - throw if not configured
    const npmScope = this.getNpmScope();
    const assembleOptions: AssembleArtifactTaskOptions = {npmScope};

    this.preBuildTasks = [
      new SourceHashTask(this.sfpmPackage, projectDir, this.logger),
    ];
    this.postBuildTasks = [
      new AssembleArtifactTask(this.sfpmPackage, projectDir, assembleOptions),
      new GitTagTask(this.sfpmPackage, projectDir),
    ];
  }

  public async connect(username: string): Promise<void> {
    this.devhubOrg = await Org.create({aliasOrUsername: username});
    if (!this.devhubOrg.isDevHubOrg()) {
      throw new Error('Must connect to a dev hub org');
    }

    if (!this.devhubOrg.getConnection()) {
      throw new Error('Unable to connect to org');
    }
  }

  public async exec(): Promise<void> {
    if (!this.devhubOrg) {
      throw new Error('Must run connect() before exec()');
    }

    await this.runPreBuildTasks();
    await this.buildPackage();
    await this.runPostBuildTasks();
  }

  private async buildPackage(): Promise<void> {
    const sfProject = await SfProject.resolve(this.workingDirectory);

    // Get build options from package metadata
    const buildOptions = this.sfpmPackage.metadata.orchestration.buildOptions as SfpmUnlockedPackageBuildOptions;
    const waitTime = Duration.minutes(buildOptions?.waitTime || 120);
    const pollingFrequency = Duration.seconds(30);

    // Emit create start event
    this.emit('unlocked:create:start', {
      packageId: this.sfpmPackage.packageId,
      packageName: this.sfpmPackage.packageName,
      timestamp: new Date(),
      versionNumber: this.sfpmPackage.version || '',
    });

    // Setup lifecycle listener for progress logging
    const lifecycle = Lifecycle.getInstance();
    const progressListener = async (data: PackageVersionCreateRequestResult) => {
      // Emit progress event
      this.emit('unlocked:create:progress', {
        message: data.Status,
        packageName: this.sfpmPackage.packageName,
        status: data.Status,
        timestamp: new Date(),
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
      const packageVersionCreateOptions: Record<string, unknown> = {
        asyncvalidation: buildOptions?.isAsyncValidation ?? false,
        codecoverage: buildOptions?.isCoverageEnabled ?? false,
        connection: this.devhubOrg!.getConnection(),
        installationkey: buildOptions?.installationKey,
        installationkeybypass: buildOptions?.installationKey ? undefined : true,
        packageId: this.sfpmPackage.packageId,
        project: sfProject,
        skipvalidation: buildOptions?.isSkipValidation ?? false,
        versionnumber: this.sfpmPackage.getVersionNumber('salesforce'),
        ...(buildOptions?.definitionFile
          ? {definitionfile: path.join(this.workingDirectory, buildOptions.definitionFile)}
          : {}),
        ...(this.sfpmPackage.metadata.source?.tag
          ? {tag: this.sfpmPackage.metadata.source.tag}
          : {}),
      };

      this.logger?.debug(`PackageVersion.create options: packageId=${this.sfpmPackage.packageId}, `
        + `version=${this.sfpmPackage.version}, skipvalidation=${buildOptions?.isSkipValidation ?? false}, `
        + `definitionfile=${buildOptions?.definitionFile ?? '(not set)'}`);

      const result = await PackageVersion.create(
        packageVersionCreateOptions as any,
        {frequency: pollingFrequency, timeout: waitTime},
      );

      // Log key result fields (avoid JSON.stringify as result may contain circular Connection refs)
      this.logger?.debug(`Package Result: Status=${result.Status}, VersionId=${result.SubscriberPackageVersionId}, Version=${result.VersionNumber}`);

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
          codeCoverage: result.CodeCoverage ?? undefined,
          createdDate: result.CreatedDate,
          hasMetadataRemoved: result.HasMetadataRemoved ?? undefined,
          hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
          packageId: result.Package2Id,
          packageName: this.sfpmPackage.packageName,
          packageVersionId: result.SubscriberPackageVersionId,
          status: result.Status,
          subscriberPackageVersionId: result.SubscriberPackageVersionId,
          timestamp: new Date(),
          totalNumberOfMetadataFiles: result.TotalNumberOfMetadataFiles ?? undefined,
          totalSizeOfMetadataFiles: result.TotalSizeOfMetadataFiles ?? undefined,
          versionNumber: result.VersionNumber || this.sfpmPackage.version || '',
        });

        // Update other metadata if available in result
        if (result.Status === 'Success') {
          // We could fetch more info here if needed
        }
      } else {
        throw new Error(`Package creation failed or timed out. Status: ${result.Status}`);
      }

      if (buildOptions?.isCoverageEnabled && !this.sfpmPackage.isOrgDependent && !buildOptions?.isAsyncValidation && !result.HasPassedCodeCoverageCheck) {
        throw new Error('This package has not meet the minimum coverage requirement of 75%');
      }
    } catch (error: any) {
      const details = [
        error.message,
        error.data ? `Data: ${JSON.stringify(error.data)}` : '',
        error.actions?.length ? `Actions: ${error.actions.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      this.logger?.error(`Error during package creation: ${details}`);
      throw new Error(`Unable to create ${this.sfpmPackage.packageName}:\n${details}`, {cause: error});
    } finally {
      lifecycle.removeAllListeners('packageVersionCreate:progress');
    }
  }

  private emitTaskCompleteEvent(taskName: string, taskType: 'post-build' | 'pre-build', success: boolean): void {
    this.emit('task:complete', {
      packageName: this.sfpmPackage.packageName,
      success,
      taskName,
      taskType,
      timestamp: new Date(),
    });
  }

  private emitTaskEvent(taskName: string, taskType: 'post-build' | 'pre-build', success: boolean): void {
    this.emit('task:start', {
      packageName: this.sfpmPackage.packageName,
      taskName,
      taskType,
      timestamp: new Date(),
    });
  }

  /**
   * Get npm scope from builder options.
   *
   * @throws Error if npm scope is not configured
   */
  private getNpmScope(): string {
    if (!this.options.npmScope) {
      throw new Error('npm scope not configured. Add npmScope to sfpm.config.ts (e.g., npmScope: "@myorg")');
    }

    return this.options.npmScope;
  }

  /**
   * @description: cleanup sfpm constructs in working directory
   */
  private async pruneOrgDependentPackage(): Promise<void> {
    if (!this.sfpmPackage.isOrgDependent) {
      return;
    }

    this.emit('unlocked:prune:start', {
      packageName: this.sfpmPackage.packageName,
      reason: 'Org-dependent package requires pruning',
      timestamp: new Date(),
    });

    const projectConfig = (await ProjectService.getInstance(this.workingDirectory)).getProjectConfig();
    const prunedDefinition = projectConfig.getPrunedDefinition(this.sfpmPackage.packageName, {
      isOrgDependent: this.sfpmPackage.isOrgDependent,
      removeCustomProperties: true,
    });

    await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), prunedDefinition, {spaces: 4});

    this.emit('unlocked:prune:complete', {
      packageName: this.sfpmPackage.packageName,
      prunedFiles: 1,
      timestamp: new Date(),
    });
  }

  private async runPostBuildTasks(): Promise<void> {
    for (const task of this.postBuildTasks) {
      const taskName = task.constructor.name;

      this.emitTaskEvent(taskName, 'post-build', true);
      try {
        // eslint-disable-next-line no-await-in-loop -- we want to run tasks sequentially and stop on first failure
        await task.exec();

        this.emitTaskCompleteEvent(taskName, 'post-build', true);
      } catch (error) {
        this.emitTaskCompleteEvent(taskName, 'post-build', false);

        throw error;
      }
    }
  }

  private async runPreBuildTasks(): Promise<void> {
    if (this.sfpmPackage.stagingDirectory) {
      this.workingDirectory = this.sfpmPackage.stagingDirectory;
    }

    await this.pruneOrgDependentPackage();

    for (const task of this.preBuildTasks) {
      const taskName = task.constructor.name;

      this.emitTaskEvent(taskName, 'pre-build', true);
      try {
        // eslint-disable-next-line no-await-in-loop -- we want to run tasks sequentially and stop on first failure
        await task.exec();
        this.emitTaskCompleteEvent(taskName, 'pre-build', true);
      } catch (error) {
        const success = error instanceof Error && (error as any).code === 'BUILD_NOT_REQUIRED';
        this.emitTaskCompleteEvent(taskName, 'pre-build', success);

        throw error;
      }
    }
  }
}
