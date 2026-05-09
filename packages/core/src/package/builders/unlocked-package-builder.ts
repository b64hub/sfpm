import {Lifecycle, Org, SfProject} from '@salesforce/core';
import {Duration} from '@salesforce/kit';
import {PackageVersion, PackageVersionCreateRequestResult} from '@salesforce/packaging';
import fs from 'fs-extra';
import EventEmitter from 'node:events';
import path from 'node:path';

import ProjectService from '../../project/project-service.js';
import {toSalesforceProjectJson} from '../../project/providers/sfdx-project-adapter.js';
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
    if (this.sfpmPackage.workingDirectory) {
      this.workingDirectory = this.sfpmPackage.workingDirectory;
    }

    await this.pruneOrgDependentPackage();
    await this.buildPackage();
  }

  /**
   * Apply a successful create result to the package — updates version,
   * emits the completion event, and enforces code coverage if required.
   *
   * Used both in the happy path and the verify-after-failure recovery.
   */
  private applyCreateResult(
    result: PackageVersionCreateRequestResult,
    buildOptions?: SfpmUnlockedPackageBuildOptions,
  ): void {
    this.sfpmPackage.packageVersionId = result.SubscriberPackageVersionId ?? undefined;

    if (result.VersionNumber) {
      this.sfpmPackage.version = result.VersionNumber;
      this.logger?.debug(`Updated package version to ${result.VersionNumber}`);
    }

    this.emit('unlocked:create:complete', {
      codeCoverage: result.CodeCoverage ?? undefined,
      createdDate: result.CreatedDate ?? undefined,
      hasMetadataRemoved: result.HasMetadataRemoved ?? undefined,
      hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
      packageId: result.Package2Id ?? '',
      packageName: this.sfpmPackage.packageName,
      packageVersionCreateRequestId: result.Id,
      packageVersionId: result.SubscriberPackageVersionId ?? '',
      status: result.Status,
      subscriberPackageVersionId: result.SubscriberPackageVersionId ?? '',
      timestamp: new Date(),
      totalNumberOfMetadataFiles: result.TotalNumberOfMetadataFiles ?? undefined,
      totalSizeOfMetadataFiles: result.TotalSizeOfMetadataFiles ?? undefined,
      versionNumber: result.VersionNumber || this.sfpmPackage.version || '',
    });

    if (buildOptions?.codeCoverage && !this.sfpmPackage.isOrgDependent && !buildOptions?.isAsyncValidation && !result.HasPassedCodeCoverageCheck) {
      throw new Error('This package has not meet the minimum coverage requirement of 75%');
    }
  }

  private async buildPackage(): Promise<void> {
    await this.rewriteMetadataPathsForCwd();

    const sfProject = await SfProject.resolve(this.workingDirectory);
    const buildOptions = this.sfpmPackage.metadata.orchestration.build as SfpmUnlockedPackageBuildOptions;
    const waitTime = Duration.minutes(buildOptions?.waitTime || 120);
    const pollingFrequency = Duration.seconds(30);

    this.emit('unlocked:create:start', {
      packageId: this.sfpmPackage.packageId,
      packageName: this.sfpmPackage.packageName,
      timestamp: new Date(),
      versionNumber: this.sfpmPackage.version || '',
    });

    const tracker = {lastRequestId: undefined as string | undefined, lastStatus: undefined as string | undefined};
    const lifecycle = Lifecycle.getInstance();
    lifecycle.on('packageVersionCreate:progress', async (data: PackageVersionCreateRequestResult) => {
      this.handleCreateProgress(data, tracker, pollingFrequency);
    });

    try {
      const result = await this.createPackageVersion(sfProject, buildOptions, waitTime, pollingFrequency);
      this.applyCreateResult(result, buildOptions);
    } catch (error: any) {
      await this.handleCreateFailure(error, tracker, buildOptions, waitTime);
    } finally {
      lifecycle.removeAllListeners('packageVersionCreate:progress');
    }
  }

  /**
   * Assemble PackageVersion.create options and invoke the Salesforce API.
   * Returns the result on success, or throws if the result has no SubscriberPackageVersionId.
   */
  private async createPackageVersion(
    sfProject: SfProject,
    buildOptions: SfpmUnlockedPackageBuildOptions | undefined,
    waitTime: Duration,
    pollingFrequency: Duration,
  ): Promise<PackageVersionCreateRequestResult> {
    const packageVersionCreateOptions: Record<string, unknown> = {
      asyncvalidation: buildOptions?.isAsyncValidation ?? false,
      codecoverage: buildOptions?.codeCoverage ?? false,
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

    this.logger?.debug(`Package Result: Status=${result.Status}, VersionId=${result.SubscriberPackageVersionId}, Version=${result.VersionNumber}`);

    if (!result.SubscriberPackageVersionId) {
      throw new Error(`Package creation failed or timed out.\n${result.Error?.join('\n')}`);
    }

    return result;
  }

  /**
   * Handle a failed PackageVersion.create call. Attempts verify-after-failure
   * recovery via getCreateStatus, detects timeouts, and formats error messages.
   *
   * Returns normally only when server-side creation succeeded despite the client error.
   * Throws in all other cases.
   */
  private async handleCreateFailure(
    error: any,
    tracker: {lastRequestId?: string; lastStatus?: string},
    buildOptions: SfpmUnlockedPackageBuildOptions | undefined,
    waitTime: Duration,
  ): Promise<void> {
    const {lastRequestId, lastStatus} = tracker;

    // If we have a request ID, check whether SF actually completed the work
    // despite the client-side failure (connection drop, timeout, etc.)
    if (lastRequestId) {
      try {
        this.logger?.debug(`Create failed for ${this.sfpmPackage.packageName}, verifying server-side status (request ${lastRequestId})...`);
        const status = await PackageVersion.getCreateStatus(
          lastRequestId,
          this.devhubOrg!.getConnection(),
        );

        if (status.Status === 'Success' && status.SubscriberPackageVersionId) {
          this.logger?.info('Package version creation succeeded server-side despite client error');
          this.applyCreateResult(status, buildOptions);
          return;
        }

        if (status.Status === 'Error') {
          const serverErrors = status.Error?.map((e: any) =>
            typeof e === 'string' ? e : e.Message).join('; ') ?? 'Unknown server error';
          this.logger?.error(`Server-side creation failed: ${serverErrors}`);
          throw new Error(`Unable to create ${this.sfpmPackage.packageName}:\n${serverErrors}`, {cause: error});
        }

        // Still in progress (Queued / InProgress / Verifying)
        const timeoutMsg = [
          `Package version creation for ${this.sfpmPackage.packageName} was interrupted but is still in progress on the server.`,
          '',
          `  Request ID: ${lastRequestId}`,
          `  Last Status: ${status.Status}`,
          '',
          'Check status with:',
          `  sf package version create report -i ${lastRequestId} -v ${this.devhubOrg!.getUsername()}`,
        ].join('\n');

        this.logger?.error(timeoutMsg);
        throw new Error(timeoutMsg, {cause: error});
      } catch (verifyError) {
        // If the verify query itself fails, check if it's our own rethrown error
        if (verifyError instanceof Error && verifyError.cause === error) {
          throw verifyError;
        }

        // Verify query failed (connection still down) — fall through to original error handling
        this.logger?.debug(`Could not verify server-side status: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      }
    }

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
  }

  /**
   * Handle a lifecycle progress event during package version creation.
   * Tracks the request ID and status, and emits progress events.
   */
  private handleCreateProgress(
    data: PackageVersionCreateRequestResult,
    tracker: {lastRequestId?: string; lastStatus?: string},
    pollingFrequency: Duration,
  ): void {
    if (data.Id) tracker.lastRequestId = data.Id;
    tracker.lastStatus = data.Status;

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

    await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), toSalesforceProjectJson(prunedDefinition), {spaces: 4});

    this.emit('unlocked:prune:complete', {
      packageName: this.sfpmPackage.packageName,
      prunedFiles: 1,
      timestamp: new Date(),
    });
  }

  /**
   * Rewrites seedMetadata / unpackagedMetadata paths in the staged
   * sfdx-project.json so they resolve correctly from process.cwd().
   *
   * The assembly step writes these paths relative to the staging root
   * (where sfdx-project.json lives) — the standard Salesforce convention.
   * However, `@salesforce/packaging` resolves them via
   * `path.join(process.cwd(), relativePath)` instead of relative to the
   * project root. This method bridges that gap by converting the paths
   * from staging-dir-relative to CWD-relative, so `path.join` normalises
   * the ".." segments to the correct absolute path.
   */
  private async rewriteMetadataPathsForCwd(): Promise<void> {
    const projectJsonPath = path.join(this.workingDirectory, 'sfdx-project.json');
    if (!await fs.pathExists(projectJsonPath)) return;

    const projectJson = await fs.readJson(projectJsonPath);
    const pkg = projectJson.packageDirectories?.[0];
    if (!pkg) return;

    let modified = false;
    const cwd = process.cwd();

    if (pkg.seedMetadata?.path) {
      const absolutePath = path.resolve(this.workingDirectory, pkg.seedMetadata.path);
      pkg.seedMetadata.path = path.relative(cwd, absolutePath);
      modified = true;
    }

    if (pkg.unpackagedMetadata?.path) {
      const absolutePath = path.resolve(this.workingDirectory, pkg.unpackagedMetadata.path);
      pkg.unpackagedMetadata.path = path.relative(cwd, absolutePath);
      modified = true;
    }

    if (modified) {
      await fs.writeJson(projectJsonPath, projectJson, {spaces: 4});
      this.logger?.debug('Rewrote metadata paths in staged sfdx-project.json relative to CWD');
    }
  }
}
