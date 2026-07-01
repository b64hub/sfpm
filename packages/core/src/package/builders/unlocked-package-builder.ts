import {Org} from '@salesforce/core';
import fs from 'fs-extra';
import path from 'node:path';

import type {BuildEventSink} from '../../events/build-event-bus.js';

import ProjectService from '../../project/project-service.js';
import {toSalesforceProjectJson} from '../../project/providers/sfdx-project-adapter.js';
import {BuildError} from '../../types/errors.js';
import Logger from '../../types/logger.js';
import {BuildOptions, PackageType} from '../../types/package.js'
import PackageService, {PackageVersionCreateReportProgress, PackageVersionCreateRequestResult} from '../package-service.js';
import SfpmPackage, {SfpmUnlockedPackage} from '../sfpm-package.js';
import {
  Builder, BuilderResult, BuildTaskRegistration, RegisterBuilder,
} from './builder-registry.js';
import {assembleArtifactTask} from './tasks/assemble-artifact-task.js';

// eslint-disable-next-line new-cap
@RegisterBuilder(PackageType.Unlocked)
export default class UnlockedPackageBuilder implements Builder {
  public tasks: BuildTaskRegistration[] = [];
  private devhub?: Org;
  private logger?: Logger;
  private options: BuildOptions;
  private sfpmPackage: SfpmUnlockedPackage;
  private sink?: BuildEventSink;
  private workingDirectory: string;

  constructor(workingDirectory: string, sfpmPackage: SfpmPackage, options: BuildOptions, logger?: Logger, sink?: BuildEventSink) {
    if (!(sfpmPackage instanceof SfpmUnlockedPackage)) {
      throw new TypeError(`UnlockedPackageBuilder received incompatible package type: ${sfpmPackage.constructor.name}`);
    }

    this.workingDirectory = workingDirectory;
    this.sfpmPackage = sfpmPackage;
    this.options = options;
    this.logger = logger;
    this.sink = sink;

    this.tasks = [
      {factory: assembleArtifactTask(), phase: 'post' as const},
    ];
  }

  public async connect(buildOrg: Org | undefined): Promise<void> {
    if (!buildOrg || !buildOrg.isDevHubOrg()) {
      throw new BuildError(this.sfpmPackage.packageName, 'Must connect to a dev hub org', {
        buildStep: 'connect',
      });
    }

    this.devhub = buildOrg;
  }

  public async exec(): Promise<BuilderResult> {
    if (!this.devhub) {
      throw new Error('Must run connect() before exec()');
    }

    // Update working directory to staging if available
    if (this.sfpmPackage.workingDirectory) {
      this.workingDirectory = this.sfpmPackage.workingDirectory;
    }

    await this.pruneOrgDependentPackage();
    await this.buildPackage();

    // Return build results — no more side-effect mutations
    const {validationState} = this.sfpmPackage;
    return {
      packageType: PackageType.Unlocked,
      packageVersionId: this.sfpmPackage.packageVersionId,
      pendingValidation: validationState?.status === 'pending' ? validationState.pending : undefined,
      validationState,
      version: this.sfpmPackage.version,
    };
  }

  /**
   * Apply a successful create result to the package — updates version,
   * emits the completion event, and enforces code coverage if required.
   *
   * Used both in the happy path and the verify-after-failure recovery.
   */
  private applyCreateResult(result: PackageVersionCreateRequestResult | undefined): void {
    if (!result) return;

    if (result.SubscriberPackageVersionId) {
      this.sfpmPackage.packageVersionId = result.SubscriberPackageVersionId;
    }

    if (result.VersionNumber) {
      this.sfpmPackage.version = result.VersionNumber;
      this.logger?.debug(`Updated package version to ${result.VersionNumber}`);
    }

    // Set validation state on the domain model
    const validated = Boolean(this.options.validation) && this.options.validation !== 'none';
    const checks: Array<'dependencies' | 'deploy' | 'test'> = validated ? ['deploy', 'test', 'dependencies'] : [];

    if (validated) {
      this.sfpmPackage.validationState = {
        checks,
        pending: {
          operationId: result.Id,
          operationType: 'package-version-request',
          packageName: this.sfpmPackage.packageName,
          startedAt: new Date().toISOString(),
          targetOrg: this.devhub?.getUsername() ?? 'unknown',
        },
        status: 'pending',
      };
    } else {
      this.sfpmPackage.validationState = {
        checks,
        status: 'passed',
        ...(result.CodeCoverage !== undefined && result.CodeCoverage !== null && {testCoverage: result.CodeCoverage}),
      };
    }

    this.sink?.createComplete({
      codeCoverage: result.CodeCoverage ?? undefined,
      createdDate: result.CreatedDate ?? undefined,
      hasMetadataRemoved: result.HasMetadataRemoved ?? undefined,
      hasPassedCodeCoverageCheck: result.HasPassedCodeCoverageCheck ?? undefined,
      packageId: result.Package2Id ?? '',
      packageVersionCreateRequestId: result.Id,
      packageVersionId: result.SubscriberPackageVersionId ?? '',
      status: result.Status,
      subscriberPackageVersionId: result.SubscriberPackageVersionId ?? '',
      totalNumberOfMetadataFiles: result.TotalNumberOfMetadataFiles ?? undefined,
      totalSizeOfMetadataFiles: result.TotalSizeOfMetadataFiles ?? undefined,
      versionNumber: result.VersionNumber || this.sfpmPackage.version || '',
    });
  }

  private async buildPackage(): Promise<void> {
    await this.rewriteMetadataPathsForCwd();

    const packageService = new PackageService(this.devhub!, this.logger);

    const buildOptions = (await ProjectService.getInstance()).resolveBuildConfig(this.sfpmPackage.packageName, this.options)

    this.sink?.createStart({
      packageId: this.sfpmPackage.packageId,
      versionNumber: this.sfpmPackage.version || '',
    });

    const validate = Boolean(this.options.validation) && this.options.validation !== 'none';
    const waitTime = buildOptions.waitTime || 120;

    this.logger?.debug(`PackageVersion.create options: packageId=${this.sfpmPackage.packageId}, `
      + `version=${this.sfpmPackage.version}, validation=${validate}`);

    const tracker: {lastRequestId?: string; lastStatus?: string} = {
      lastRequestId: undefined,
      lastStatus: undefined,
    }

    let result: PackageVersionCreateRequestResult | undefined;

    try {
      result = await packageService.createPackageVersion(
        this.sfpmPackage.packageId,
        {
          apiVersion: this.sfpmPackage.apiVersion,
          asyncvalidation: validate,
          codecoverage: validate,
          definitionfile: buildOptions.unlocked?.definitionFile,
          installationkey: buildOptions.unlocked?.installationKey,
          installationkeybypass: buildOptions.unlocked?.installationKey ? undefined : true,
          skipvalidation: !validate,
          tag: this.sfpmPackage.tag,
          versionnumber: this.sfpmPackage.getVersionNumber('salesforce'),
          wait: waitTime,
        },
        progress => this.handleProgress(progress, tracker),
      )
    } catch (error) {
      await this.handleFailure(packageService, error, tracker, waitTime);
    }

    this.applyCreateResult(result);
  }

  /**
   * Handle a failed PackageVersion.create call. Attempts verify-after-failure
   * recovery via getCreateStatus, detects timeouts, and formats error messages.
   *
   * Returns normally only when server-side creation succeeded despite the client error.
   * Throws in all other cases.
   */
  private async handleFailure(
    packageService: PackageService,
    error: any,
    tracker: {lastRequestId?: string; lastStatus?: string},
    waitTime: number,
  ): Promise<void> {
    const {lastRequestId, lastStatus} = tracker;

    if (lastRequestId) {
      try {
        this.logger?.debug(`Create failed for ${this.sfpmPackage.packageName}, verifying server-side status (request ${lastRequestId})...`);
        const status = await packageService.getVersionCreateStatus(lastRequestId);

        if (status.Status === 'Success' && status.SubscriberPackageVersionId) {
          this.logger?.info('Package version creation succeeded server-side despite client error');
          this.applyCreateResult(status);
          return;
        }

        if (status.Status === 'Error') {
          const serverErrors = status.Error?.map((e: any) =>
            typeof e === 'string' ? e : e.Message).join('; ') ?? 'Unknown server error';
          this.logger?.error(`Server-side creation failed: ${serverErrors}`);
          throw new BuildError(this.sfpmPackage.packageName, `Unable to create ${this.sfpmPackage.packageName}:\n${serverErrors}`, {
            buildStep: 'create',
            cause: error,
          });
        }

        // Still in progress (Queued / InProgress / Verifying)
        const timeoutMsg = [
          `Package version creation for ${this.sfpmPackage.packageName} was interrupted but is still in progress on the server.`,
          '',
          `  Request ID: ${lastRequestId}`,
          `  Last Status: ${status.Status}`,
          '',
          'Check status with:',
          `  sf package version create report -i ${lastRequestId} -v ${this.devhub!.getUsername()}`,
        ].join('\n');

        this.logger?.error(timeoutMsg);
        throw new BuildError(this.sfpmPackage.packageName, timeoutMsg, {
          buildStep: 'create',
          cause: error,
        });
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
        `Package version creation for ${this.sfpmPackage.packageName} timed out after ${waitTime} minutes.`,
        'The request is still in progress on the server.',
        '',
        `  Request ID: ${lastRequestId}`,
        `  Last Status: ${lastStatus ?? 'Unknown'}`,
        '',
        'Check status with:',
        `  sf package version create report -i ${lastRequestId} -v ${this.devhub!.getUsername()}`,
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
  private handleProgress(
    data: PackageVersionCreateReportProgress,
    tracker: {lastRequestId?: string; lastStatus?: string},
  ): void {
    if (data.Id) tracker.lastRequestId = data.Id;
    tracker.lastStatus = data.Status;

    this.sink?.createProgress({
      message: data.Status,
      status: data.Status,
    });

    if (this.logger) {
      this.logger.info(`Status: ${data.Status}`);
      if (data.Error?.length) {
        this.logger.error(`Creation errors: ${data.Error.join('\n')}`);
      }
    }
  }

  /**
   * @description: cleanup sfpm constructs in working directory
   * TODO: move file write responsibility to ProjectService
   */
  private async pruneOrgDependentPackage(): Promise<void> {
    if (!this.sfpmPackage.isOrgDependent) {
      return;
    }

    this.sink?.pruneStart({
      reason: 'Org-dependent package requires pruning',
    });

    const projectService = await ProjectService.getInstance(this.workingDirectory);
    const prunedDefinition = projectService.resolveForPackage(this.sfpmPackage.packageName, {
      isOrgDependent: true,
    });

    await fs.writeJson(path.join(this.workingDirectory, 'sfdx-project.json'), toSalesforceProjectJson(prunedDefinition), {spaces: 4});

    this.sink?.pruneComplete({
      prunedFiles: 1,
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
