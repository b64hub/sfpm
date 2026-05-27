import {Org} from '@salesforce/core';
import {type DeploySetOptions} from '@salesforce/source-deploy-retrieve';
import EventEmitter from 'node:events';

import {BuildError} from '../../../types/errors.js';
import {Logger} from '../../../types/logger.js';
import {SfpmMetadataPackage} from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';

/** Minimum code coverage percentage required for validation to pass */
const COVERAGE_THRESHOLD = 75;

const delay = (ms: number): Promise<void> => new Promise(resolve => {
  setTimeout(resolve, ms);
});

/** Structural type for the Tooling API connection subset used by this task. */
interface ToolingConnection {
  query: <T>(q: string) => Promise<{records: T[]}>;
  runTestsAsynchronous: (request: {classNames: string}) => Promise<string>;
}

/** Shape of a row from `SELECT ... FROM ApexTestRunResult` (Tooling API). */
interface ApexTestRunResult {
  MethodsCompleted: number;
  MethodsEnqueued: number;
  MethodsFailed: number;
  Status: 'Aborted' | 'Completed' | 'Failed' | 'Processing' | 'Queued';
}

/** Shape of a row from `SELECT ... FROM ApexTestResult WHERE Outcome = 'Fail'` (Tooling API). */
interface ApexTestFailure {
  ApexClass: {Name: string};
  Message: string;
  MethodName: string;
  StackTrace?: string;
}

/**
 * Handle to an in-flight validation job. Returned by {@link ValidationTask.startAsync}
 * and consumed by {@link ValidationTask.awaitResult} to poll and process the outcome.
 *
 * This enables a future job queue pattern: start N validations in parallel,
 * collect the handles, then await results as they complete.
 */
export interface ValidationJobHandle {
  /** The Salesforce async job ID (deploy ID or test run ID). */
  jobId: string;
  /** Which execution path this job represents. */
  mode: 'deploy' | 'test-only';
  /** Package name this job validates. */
  packageName: string;
  /** Test class names being executed. */
  testClassNames: string[];
}

export interface ValidationTaskOptions {
  /**
   * Test-only mode: run tests via the Apex Test API without deploying metadata.
   * Used for downstream unchanged packages that still need their tests exercised.
   * In this mode, coverage is not checked — only pass/fail matters.
   */
  testOnly?: boolean;
}

/**
 * Build task that validates a source package by deploying metadata to a build org,
 * running the package's specified Apex tests, and checking code coverage.
 *
 * This emulates the Salesforce unlocked package build validation for source packages:
 * 1. Deploy metadata to the build org
 * 2. Run the package's Apex tests (RunSpecifiedTests)
 * 3. Check that code coverage meets the 75% threshold
 *
 * Supports a **test-only mode** (`testOnly: true`) for downstream unchanged packages:
 * runs tests via the Apex Test API without deploying metadata. Coverage is not checked.
 *
 * Throws {@link BuildError} when:
 * - The package contains Apex but has no test classes defined
 * - The deployment fails (deploy mode only)
 * - Any Apex test fails
 * - Code coverage is below the threshold (deploy mode only)
 */
export default class ValidationTask implements BuildTask {
  private readonly buildOrg: string;
  private readonly eventEmitter?: EventEmitter;
  private readonly logger?: Logger;
  private readonly options: ValidationTaskOptions;
  private readonly sfpmPackage: SfpmMetadataPackage;

  public constructor(
    sfpmPackage: SfpmMetadataPackage,
    buildOrg: string,
    logger?: Logger,
    eventEmitter?: EventEmitter,
    options?: ValidationTaskOptions,
  ) {
    this.sfpmPackage = sfpmPackage;
    this.buildOrg = buildOrg;
    this.logger = logger;
    this.eventEmitter = eventEmitter;
    this.options = options ?? {};
  }

  /**
   * Await and process the result of a previously started validation job.
   * Polls the Salesforce API until the job completes, then asserts pass/fail.
   *
   * Throws {@link BuildError} on test failures, deployment failures, or
   * insufficient coverage (deploy mode only).
   */
  public async awaitResult(handle: ValidationJobHandle): Promise<void> {
    const {jobId, mode, packageName} = handle;
    const org = await Org.create({aliasOrUsername: this.buildOrg});
    const connection = org.getConnection();

    if (mode === 'test-only') {
      await this.awaitTestOnly(packageName, connection as any, jobId);
    } else {
      await this.awaitDeploy(packageName, connection, jobId);
    }

    this.logger?.info(`Validation passed for '${packageName}'`);
  }

  /**
   * Synchronous convenience — starts the validation and awaits the result.
   * Equivalent to calling `startAsync()` followed by `awaitResult()`.
   */
  public async exec(): Promise<void> {
    const handle = await this.startAsync();
    if (!handle) return; // no-op (no Apex)
    await this.awaitResult(handle);
  }

  /**
   * Start the validation asynchronously and return a job handle.
   * The handle can be stored and later passed to {@link awaitResult} to
   * poll for completion and process the outcome.
   *
   * Returns `null` if the package has no Apex (nothing to validate).
   */
  public async startAsync(): Promise<null | ValidationJobHandle> {
    const {packageName} = this.sfpmPackage;

    if (!this.sfpmPackage.hasApex) {
      this.logger?.info(`Package '${packageName}' has no Apex — skipping test validation`);
      return null;
    }

    const testClassNames = this.guardTestClasses(packageName);
    const mode = this.options.testOnly ? 'test-only' : 'deploy';

    this.logger?.info(`Validating package '${packageName}' against ${this.buildOrg} [${mode}]`);
    this.logger?.info(`Running ${testClassNames.length} test class(es): ${testClassNames.join(', ')}`);
    this.emitTestStart(packageName, testClassNames.length);

    const org = await Org.create({aliasOrUsername: this.buildOrg});
    const connection = org.getConnection();

    let jobId: string;

    if (this.options.testOnly) {
      jobId = await connection.tooling.runTestsAsynchronous({
        classNames: testClassNames.join(','),
      }) as string;
    } else {
      const componentSet = this.sfpmPackage.getComponentSet();
      const deployOptions: DeploySetOptions = {
        apiOptions: {
          runTests: testClassNames,
          testLevel: 'RunSpecifiedTests' as DeploySetOptions['apiOptions'] extends {testLevel?: infer T} ? T : never,
        },
        usernameOrConnection: connection,
      };
      const deploy = await componentSet.deploy(deployOptions);
      jobId = deploy.id!;
    }

    this.logger?.debug(`Job started: ${jobId} [${mode}]`);

    return {
      jobId,
      mode: this.options.testOnly ? 'test-only' : 'deploy',
      packageName,
      testClassNames,
    };
  }

  // ==========================================================================
  // Await helpers (process async job results)
  // ==========================================================================

  private assertCoverage(packageName: string, coveragePercentage: number): void {
    if (coveragePercentage >= COVERAGE_THRESHOLD) return;

    throw new BuildError(
      packageName,
      `Code coverage ${coveragePercentage}% is below the required ${COVERAGE_THRESHOLD}%`,
      {
        buildStep: 'validation',
        context: {buildOrg: this.buildOrg, coveragePercentage, coverageRequired: COVERAGE_THRESHOLD},
      },
    );
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private assertDeploySuccess(packageName: string, response: any): void {
    if (response.success) return;

    const failures = response.details?.componentFailures;
    const failuresArray = Array.isArray(failures) ? failures : failures ? [failures] : [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const errorMessages = failuresArray.map((f: any) => `${f.fullName}: ${f.problem}`).join('\n')
      || 'Unknown deployment error';

    this.emitTestComplete(packageName, {failed: 0, passed: 0, testCount: 0});

    throw new BuildError(packageName, `Validation deployment failed:\n${errorMessages}`, {
      buildStep: 'validation',
      context: {buildOrg: this.buildOrg},
    });
  }

  // ==========================================================================
  // Steps
  // ==========================================================================

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private assertTestsPassed(packageName: string, testResults: {coveragePercentage: number; failuresArray: any[]; numFailures: number; numTestsRun: number}): void {
    const {coveragePercentage, failuresArray, numFailures, numTestsRun} = testResults;
    if (numFailures === 0) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const failureMessages = failuresArray.map((f: any) => `${f.name}.${f.methodName}: ${f.message}`).join('\n');

    throw new BuildError(packageName, `${numFailures} Apex test(s) failed:\n${failureMessages}`, {
      buildStep: 'validation',
      context: {
        buildOrg: this.buildOrg, coveragePercentage, numFailures, numTestsRun,
      },
    });
  }

  /**
   * Await the result of an async deploy+test job.
   * Polls the deploy status via Metadata API, then asserts success, tests, and coverage.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async awaitDeploy(packageName: string, connection: any, deployId: string): Promise<void> {
    const response = await this.pollDeploy(connection, deployId);

    this.assertDeploySuccess(packageName, response);

    const {coveragePercentage, failuresArray, numFailures, numPassed, numTestsRun}
      = this.extractTestResults(response);

    this.sfpmPackage.testCoverage = coveragePercentage;
    this.emitTestComplete(packageName, {
      coveragePercentage, failed: numFailures, passed: numPassed, testCount: numTestsRun,
    });

    this.assertTestsPassed(packageName, {
      coveragePercentage, failuresArray, numFailures, numTestsRun,
    });
    this.assertCoverage(packageName, coveragePercentage);
  }

  // ==========================================================================
  // Guards
  // ==========================================================================

  /**
   * Await the result of an async test-only job.
   * Polls the test run, then asserts pass/fail (no coverage check).
   */
  private async awaitTestOnly(packageName: string, connection: {tooling: ToolingConnection}, testRunId: string): Promise<void> {
    const testResult = await this.pollTestRun(connection, testRunId);
    const numTestsRun = Number(testResult.MethodsCompleted ?? 0);
    const numFailures = Number(testResult.MethodsFailed ?? 0);
    const numPassed = numTestsRun - numFailures;

    this.emitTestComplete(packageName, {failed: numFailures, passed: numPassed, testCount: numTestsRun});

    if (numFailures > 0) {
      const failures = await this.fetchTestFailures(connection, testRunId);
      throw new BuildError(packageName, `${numFailures} Apex test(s) failed:\n${failures}`, {
        buildStep: 'validation:test-only',
        context: {buildOrg: this.buildOrg, numFailures, numTestsRun},
      });
    }

    this.logger?.info(`All ${numPassed} test(s) passed (test-only mode)`);
  }

  /**
   * Calculate overall coverage percentage from the deploy run test result.
   * Uses per-class coverage data (lines covered / total lines).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private calculateCoverage(runTestResult: any): number {
    const codeCoverage = runTestResult?.codeCoverage;
    if (!codeCoverage) return 0;

    const coverageEntries = Array.isArray(codeCoverage) ? codeCoverage : [codeCoverage];
    let totalLines = 0;
    let coveredLines = 0;

    for (const entry of coverageEntries) {
      const numLocations = Number(entry.numLocations ?? 0);
      const numLocationsNotCovered = Number(entry.numLocationsNotCovered ?? 0);
      totalLines += numLocations;
      coveredLines += numLocations - numLocationsNotCovered;
    }

    if (totalLines === 0) return 0;
    return Math.round((coveredLines / totalLines) * 100);
  }

  private emitTestComplete(packageName: string, counts: {coveragePercentage?: number; failed: number; passed: number; testCount: number}): void {
    this.eventEmitter?.emit('source:test:complete', {
      coveragePercentage: counts.coveragePercentage,
      coverageRequired: COVERAGE_THRESHOLD,
      failed: counts.failed,
      packageName,
      passed: counts.passed,
      testCount: counts.testCount,
      timestamp: new Date(),
    });
  }

  private emitTestStart(packageName: string, testCount: number): void {
    this.eventEmitter?.emit('source:test:start', {
      packageName,
      testCount,
      testLevel: 'RunSpecifiedTests',
      timestamp: new Date(),
    });
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  /**
   * Extract test counts, coverage, and failure details from the deploy response.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTestResults(response: any) {
    const runTestResult = response.details?.runTestResult;
    const testFailures = runTestResult?.failures;
    const failuresArray = Array.isArray(testFailures) ? testFailures : testFailures ? [testFailures] : [];
    const numTestsRun = Number(runTestResult?.numTestsRun ?? 0);
    const numFailures = Number(runTestResult?.numFailures ?? 0);
    const numPassed = numTestsRun - numFailures;
    const coveragePercentage = this.calculateCoverage(runTestResult);

    return {
      coveragePercentage, failuresArray, numFailures, numPassed, numTestsRun,
    };
  }

  /**
   * Fetch failure details for a completed test run.
   */
  private async fetchTestFailures(connection: {tooling: ToolingConnection}, testRunId: string): Promise<string> {
    const query = 'SELECT MethodName, StackTrace, Message, ApexClass.Name '
      + `FROM ApexTestResult WHERE AsyncApexJobId = '${testRunId}' AND Outcome = 'Fail'`;
    const result = await connection.tooling.query<ApexTestFailure>(query);
    return (result.records ?? []).map(r => `${r.ApexClass?.Name}.${r.MethodName}: ${r.Message}`).join('\n');
  }

  /**
   * Ensure the package has test classes. Returns their resolved names.
   * Throws if the package contains Apex but defines no tests.
   */
  private guardTestClasses(packageName: string): string[] {
    const testClassNames = this.resolveTestClassNames();

    if (testClassNames.length === 0) {
      throw new BuildError(packageName, 'Package contains Apex but has no test classes defined', {
        buildStep: 'validation',
        context: {buildOrg: this.buildOrg},
      });
    }

    return testClassNames;
  }

  /**
   * Poll a Metadata API deployment until it completes.
   * Uses `connection.metadata.checkDeployStatus()` for resume-safe polling.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pollDeploy(connection: any, deployId: string): Promise<any> {
    const pollIntervalMs = 5000;
    const maxAttempts = 360; // 30 minutes

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const poll = async (attempt: number): Promise<any> => {
      if (attempt >= maxAttempts) {
        throw new BuildError(this.sfpmPackage.packageName, `Deploy ${deployId} timed out after 30 minutes`, {
          buildStep: 'validation',
          context: {buildOrg: this.buildOrg},
        });
      }

      const status = await connection.metadata.checkDeployStatus(deployId, true);

      if (status.done) {
        return status;
      }

      const deployed = status.numberComponentsDeployed || 0;
      const total = status.numberComponentsTotal || 0;
      const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;
      this.logger?.debug(`Deploy progress: ${pct}% (${deployed}/${total}) — ${status.status}`);

      await delay(pollIntervalMs);
      return poll(attempt + 1);
    };

    return poll(0);
  }

  /**
   * Poll the ApexTestRunResult until the test run completes.
   * Uses recursive scheduling to avoid `await` inside a loop.
   */
  private async pollTestRun(connection: {tooling: ToolingConnection}, testRunId: string): Promise<ApexTestRunResult> {
    const pollIntervalMs = 5000;
    const maxAttempts = 360; // 30 minutes

    const query = 'SELECT Status, MethodsCompleted, MethodsFailed, MethodsEnqueued '
      + `FROM ApexTestRunResult WHERE AsyncApexJobId = '${testRunId}'`;

    const poll = async (attempt: number): Promise<ApexTestRunResult> => {
      if (attempt >= maxAttempts) {
        throw new BuildError(this.sfpmPackage.packageName, `Test run ${testRunId} timed out after 30 minutes`, {
          buildStep: 'validation:test-only',
          context: {buildOrg: this.buildOrg},
        });
      }

      const result = await connection.tooling.query<ApexTestRunResult>(query);
      const record = result.records?.[0];

      if (!record) {
        throw new BuildError(this.sfpmPackage.packageName, `Test run ${testRunId} not found`, {
          buildStep: 'validation:test-only',
          context: {buildOrg: this.buildOrg},
        });
      }

      if (record.Status === 'Completed' || record.Status === 'Failed' || record.Status === 'Aborted') {
        return record;
      }

      this.logger?.debug(`Test run ${record.Status} — ${record.MethodsCompleted ?? 0} completed, ${record.MethodsEnqueued ?? 0} enqueued`);
      await delay(pollIntervalMs);
      return poll(attempt + 1);
    };

    return poll(0);
  }

  // ==========================================================================
  // Pollers
  // ==========================================================================

  /**
   * Resolve test class names from the package's testClasses metadata.
   * testClasses can be either plain strings or objects with a `name` property.
   */
  private resolveTestClassNames(): string[] {
    const {testClasses} = this.sfpmPackage;
    return testClasses.map(tc => (typeof tc === 'string' ? tc : tc.name));
  }
}
