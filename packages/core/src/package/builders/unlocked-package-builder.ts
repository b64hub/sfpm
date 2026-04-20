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
import SfpmPackage, {SfpmUnlockedPackage} from '../sfpm-package.js';
import {
  Builder, BuilderOptions, BuildTask, RegisterBuilder,
} from './builder-registry.js';
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

    const assembleOptions: AssembleArtifactTaskOptions = {};

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

    // Update working directory to staging if available
    if (this.sfpmPackage.stagingDirectory) {
      this.workingDirectory = this.sfpmPackage.stagingDirectory;
    }

    await this.pruneOrgDependentPackage();
    await this.buildPackage();
  }

  private async buildPackage(): Promise<void> {
    // @salesforce/packaging resolves seedMetadata / unpackagedMetadata paths
    // relative to process.cwd(), NOT the SfProject root. When building from a
    // staging directory we must chdir so those relative paths resolve correctly.
    const originalCwd = process.cwd();
    if (this.workingDirectory !== originalCwd) {
      process.chdir(this.workingDirectory);
    }

    const sfProject = await SfProject.resolve(this.workingDirectory);

    // Get build options from package metadata
    const buildOptions = this.sfpmPackage.metadata.orchestration.build as SfpmUnlockedPackageBuildOptions;
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
    let lastRequestId: string | undefined;
    let lastStatus: string | undefined;
    const progressListener = async (data: PackageVersionCreateRequestResult) => {
      // Track the request ID so we can include it in timeout errors
      if (data.Id) lastRequestId = data.Id;
      lastStatus = data.Status;

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
          packageVersionCreateRequestId: result.Id,
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
        throw new Error(`Package creation failed or timed out.\n${result.Error?.join('\n')}`);
      }

      if (buildOptions?.isCoverageEnabled && !this.sfpmPackage.isOrgDependent && !buildOptions?.isAsyncValidation && !result.HasPassedCodeCoverageCheck) {
        throw new Error('This package has not meet the minimum coverage requirement of 75%');
      }
    } catch (error: any) {
      // Detect timeout — the @salesforce/packaging library throws when the
      // polling timeout is exceeded. The error message typically contains
      // "timed out" or the last status is still "InProgress" / "Queued".
      const isTimeout = /timed?\s*out/i.test(error.message)
        || (lastStatus && !['Error', 'Success'].includes(lastStatus));

      if (isTimeout && lastRequestId) {
        const timeoutMsg = [
          `Package version creation for ${this.sfpmPackage.packageName} timed out after ${waitTime.minutes} minutes.`,
          'The request is still in progress on the server.',
          '',
          `  Request ID: ${lastRequestId}`,
          `  Last Status: ${lastStatus ?? 'Unknown'}`,
          '',
          'Check status with:',
          `  sf package version create report -i ${lastRequestId} -v ${this.devhubOrg!.getUsername()}`,
        ].join('\n');

        this.logger?.error(timeoutMsg);
        throw new Error(timeoutMsg, {cause: error});
      }

      const details = [
        error.message,
        error.data ? `Data: ${JSON.stringify(error.data)}` : '',
        error.actions?.length ? `Actions: ${error.actions.join(', ')}` : '',
      ].filter(Boolean).join('\n');

      this.logger?.error(`Error during package creation: ${details}`);
      throw new Error(`Unable to create ${this.sfpmPackage.packageName}:\n${details}`, {cause: error});
    } finally {
      lifecycle.removeAllListeners('packageVersionCreate:progress');
      if (process.cwd() !== originalCwd) {
        process.chdir(originalCwd);
      }
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
      packageName: this.sfpmPackage.packageName,
      reason: 'Org-dependent package requires pruning',
      timestamp: new Date(),
    });

    const projectService = await ProjectService.getInstance(this.workingDirectory);
    const prunedDefinition = projectService.resolveForPackage(this.sfpmPackage.packageName, {
      isOrgDependent: true,
    });

    await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), prunedDefinition, {spaces: 4});

    this.emit('unlocked:prune:complete', {
      packageName: this.sfpmPackage.packageName,
      prunedFiles: 1,
      timestamp: new Date(),
    });
  }
}
