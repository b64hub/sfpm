import type {
  ComponentSet, DeploySetOptions, MetadataApiDeploy, MetadataApiDeployStatus,
} from '@salesforce/source-deploy-retrieve';

import {Connection, Org} from '@salesforce/core';

import type {Logger} from '../types/logger.js';

/** Options for starting a metadata deployment. */
export interface DeployOptions {
  /** Apex test classes to run during deployment */
  testClasses?: string[];
  /** Test level for the deployment (default: 'NoTestRun' unless testClasses provided) */
  testLevel?: 'NoTestRun' | 'RunLocalTests' | 'RunSpecifiedTests';
}

/** A component that failed during deployment. */
export interface DeployComponentError {
  fullName: string;
  problem: string;
}


export class DeployError extends Error {
  constructor(message: string, public readonly deployId: string) {
    super(message);
  }
}

/** A single Apex test failure. */
export interface TestFailure {
  /** The failure message from Salesforce */
  message: string;
  /** The name of the method that failed */
  methodName: string;
  /** The name of the class that failed */
  name: string;
  /** The stack trace of the failure, if available */
  stackTrace?: string;
}

/** Test run results extracted from a deployment response. TODO: Break down coverage by class */
export interface TestRunResult {
  /** Aggregate code coverage percentage (0–100), undefined if not measured */
  coverage?: number;
  /** Number of test methods that failed */
  failed: number;
  /** Individual test failures with details */
  failures: TestFailure[];
  /** Number of test methods that passed */
  passed: number;
  /** Total test methods executed */
  total: number;
}

/** Normalized deployment result with rich test data and helper methods. */
export interface DeployResult {
  id: string;
  /** Number of components successfully deployed */
  deployed: number;
  /** Component-level errors */
  errors: DeployComponentError[];
  /** Format component errors as a human-readable string. */
  formatErrors(): string;
  /** Whether any tests failed during the deployment. */
  hasTestFailures(): boolean;
  /** Whether coverage meets the specified threshold. */
  meetsCoverageThreshold(threshold: number): boolean;
  /** The raw Salesforce deploy response (for advanced consumers) */
  raw: MetadataApiDeployStatus;

  /** Whether the deployment succeeded */
  success: boolean;
  /** Test results (populated when tests were executed during deployment) */
  testResults?: TestRunResult;
  /** Total components in the deployment */
  total: number;
}

/** Progress callback for deployment polling. */
export interface DeployProgress {
  deployed: number;
  percentage: number;
  status: string;
  total: number;
}

/**
 * Low-level service for deploying metadata to a Salesforce org.
 *
 * Package-agnostic — operates on a {@link ComponentSet} and an org alias.
 * Consumers compose this with higher-level concerns (validation assertions,
 * coverage checks, etc.).
 *
 * @example
 * ```ts
 * const service = new MetadataDeployService(logger);
 * const deployId = await service.deploy(componentSet, 'my-org', { testClasses: ['MyTest'] });
 * const result = await service.awaitDeploy(deployId, 'my-org');
 * ```
 */
export class MetadataDeployService {
  private readonly logger?: Logger;
  private readonly pendingDeploys = new Map<string, MetadataApiDeploy>();
  private targetOrg: Org;


  constructor(targetOrg: Org, logger?: Logger) {
    this.targetOrg = targetOrg;
    this.logger = logger;
  }

  /**
   * Wait for a previously started deployment to complete.
   * Polls the Salesforce API until the deployment finishes.
   *
   * Supports two modes:
   * - **In-process**: If the deploy was started by this instance, uses the live `MetadataApiDeploy` handle.
   * - **Fresh-polling**: If the deployId is not in the local registry (e.g., resolution from a different
   *   process), creates a fresh org connection and polls `checkDeployStatus` directly.
   */
  public async awaitDeploy(
    deployId: string,
    onProgress?: (progress: DeployProgress) => void,
  ): Promise<DeployResult> {
    const deploy = this.pendingDeploys.get(deployId);

    if (deploy) {
      return this.awaitInProcess(deploy, onProgress);
    }

    return this.awaitFreshPoll(deployId, onProgress);
  }

  /**
   * Start a metadata deployment and return the deploy ID immediately.
   * The deployment continues server-side — use {@link awaitDeploy} to wait for completion.
   */
  public async deploy(
    componentSet: ComponentSet,
    options?: DeployOptions,
  ): Promise<string> {
    const testLevel = this.getTestLevel(options);

    const deployOptions: DeploySetOptions = {
      apiOptions: {
        ...(options?.testClasses?.length && {runTests: options.testClasses}),
        testLevel: testLevel,
      },
      usernameOrConnection: this.targetOrg.getConnection(),
    };

    let deploy: MetadataApiDeploy;
    try {
      this.logger?.debug(`Starting deployment against ${this.targetOrg.getUsername()} with test level '${testLevel}'`);
      deploy = await componentSet.deploy(deployOptions);
    } catch (err) {
      this.logger?.error(`Failed to start deploy against '${this.targetOrg.getUsername()}': ${(err as Error).message}`);
      throw err as Error;
    }

    if (!deploy.id) {
      throw new Error('Deployment failed to start — no deploy ID returned');
    }

    const deployId = deploy.id;

    this.logger?.debug(`Deployment started: ${deployId} against ${this.targetOrg.getUsername()} with test level '${testLevel}'`);
    this.pendingDeploys.set(deployId, deploy);

    return deployId;
  }

  private async awaitFreshPoll(
    deployId: string,
    onProgress?: (progress: DeployProgress) => void,
    pollingIntervalMs = 5000,
    maxWaitMs = 7_200_000,
  ): Promise<DeployResult> {
    this.logger?.debug(`Fresh-polling deploy '${deployId}' against ${this.targetOrg.getUsername()}`);

    const connection = this.targetOrg.getConnection();

    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- intentional polling loop
      const status = await connection.metadata.checkDeployStatus(deployId, true) as unknown as MetadataApiDeployStatus;

      const deployed = status.numberComponentsDeployed ?? 0;
      const total = status.numberComponentsTotal ?? 0;
      const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;

      onProgress?.({
        deployed, percentage: pct, status: String(status.status), total,
      });
      this.logger?.debug(`Deploy progress: ${pct}% (${deployed}/${total}) — ${status.status}`);

      if (status.done) {
        return this.mapResult(status);
      }

      // eslint-disable-next-line no-await-in-loop
      await new Promise(resolve => {
        setTimeout(resolve, pollingIntervalMs);
      });
    }

    throw new DeployError(`Deploy '${deployId}' timed out after ${maxWaitMs / 60_000} minutes`, deployId);
  }

  private async awaitInProcess(
    deploy: MetadataApiDeploy,
    onProgress?: (progress: DeployProgress) => void,
  ): Promise<DeployResult> {
    deploy.onUpdate(status => {
      const deployed = status.numberComponentsDeployed;
      const total = status.numberComponentsTotal;
      const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;

      onProgress?.({
        deployed, percentage: pct, status: String(status.status), total,
      });
      this.logger?.debug(`Deploy progress: ${pct}% (${deployed}/${total}) — ${status.status}`);
    });

    const result = await deploy.pollStatus();
    this.pendingDeploys.delete(deploy.id!);

    return this.mapResult(result.response);
  }

  private extractTestResults(response: MetadataApiDeployStatus): TestRunResult | undefined {
    const runTestResult = (response.details as any)?.runTestResult;
    if (!runTestResult) return undefined;

    const numTestsRun = Number(runTestResult.numTestsRun ?? 0);
    if (numTestsRun === 0) return undefined;

    const numFailures = Number(runTestResult.numFailures ?? 0);

    // Parse individual failures
    const rawFailures = toArray(runTestResult.failures);
    const failures: TestFailure[] = rawFailures.map((f: any) => ({
      message: f.message ?? '',
      methodName: f.methodName ?? '',
      name: f.name ?? '',
      stackTrace: f.stackTrace,
    }));

    // Calculate aggregate coverage
    const codeCoverage = toArray(runTestResult.codeCoverage);
    let coverage: number | undefined;

    if (codeCoverage.length > 0) {
      let totalLines = 0;
      let coveredLines = 0;
      for (const c of codeCoverage) {
        const total = Number((c as any).numLocations ?? 0);
        const uncovered = Number((c as any).numLocationsNotCovered ?? 0);
        totalLines += total;
        coveredLines += total - uncovered;
      }

      coverage = totalLines > 0 ? Math.round((coveredLines / totalLines) * 100) : 0;
    }

    return {
      coverage,
      failed: numFailures,
      failures,
      passed: numTestsRun - numFailures,
      total: numTestsRun,
    };
  }

  private getTestLevel(options?: DeployOptions): DeployOptions['testLevel'] {
    return options?.testClasses?.length
      ? 'RunSpecifiedTests'
      : (options?.testLevel ?? 'NoTestRun');
  }

  private mapResult(response: MetadataApiDeployStatus): DeployResult {
    const componentFailures = toArray(response.details.componentFailures);
    const errors: DeployComponentError[] = componentFailures.map(f => ({
      fullName: f.fullName,
      problem: f.problem ?? '',
    }));

    const testResults = this.extractTestResults(response);

    return {
      id: response.id,
      deployed: response.numberComponentsDeployed,
      errors,
      formatErrors() {
        if (this.errors.length === 0) return '';
        return this.errors.map(e => `${e.fullName}: ${e.problem}`).join('\n');
      },
      hasTestFailures() {
        return (this.testResults?.failed ?? 0) > 0;
      },
      meetsCoverageThreshold(threshold: number) {
        if (this.testResults?.coverage === undefined) return true;
        return this.testResults.coverage >= threshold;
      },
      raw: response,
      success: response.success,
      testResults,
      total: response.numberComponentsTotal,
    };
  }
}

/**
 * Normalize a Salesforce API response field that may be a single object, an array, or undefined.
 */
function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}