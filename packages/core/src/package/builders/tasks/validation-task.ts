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

  public async exec(): Promise<void> {
    const {packageName} = this.sfpmPackage;

    if (!this.sfpmPackage.hasApex) {
      this.logger?.info(`Package '${packageName}' has no Apex — skipping test validation`);
      return;
    }

    const testClassNames = this.guardTestClasses(packageName);
    const mode = this.options.testOnly ? 'test-only' : 'deploy';

    this.logger?.info(`Validating package '${packageName}' against ${this.buildOrg} [${mode}]`);
    this.logger?.info(`Running ${testClassNames.length} test class(es): ${testClassNames.join(', ')}`);
    this.emitTestStart(packageName, testClassNames.length);

    if (this.options.testOnly) {
      await this.runTestsOnly(packageName, testClassNames);
    } else {
      await this.deployAndValidate(packageName, testClassNames);
    }

    this.logger?.info(`Validation passed for '${packageName}'`);
  }

  // ==========================================================================
  // Execution paths
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

  // ==========================================================================
  // Guards
  // ==========================================================================

  /**
   * Full validation: deploy metadata with tests, check coverage.
   */
  private async deployAndValidate(packageName: string, testClassNames: string[]): Promise<void> {
    const response = await this.deployWithTests(testClassNames);
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

  /**
   * Deploy the package's metadata to the build org with RunSpecifiedTests.
   * Returns the raw Metadata API deploy response.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async deployWithTests(testClassNames: string[]): Promise<any> {
    const org = await Org.create({aliasOrUsername: this.buildOrg});
    const connection = org.getConnection();
    const componentSet = this.sfpmPackage.getComponentSet();

    const deployOptions: DeploySetOptions = {
      apiOptions: {
        runTests: testClassNames,
        testLevel: 'RunSpecifiedTests' as DeploySetOptions['apiOptions'] extends {testLevel?: infer T} ? T : never,
      },
      usernameOrConnection: connection,
    };

    const deploy = await componentSet.deploy(deployOptions);
    this.logger?.debug(`Deploy started: ${deploy.id}`);

    deploy.onUpdate(update => {
      const deployed = update.numberComponentsDeployed || 0;
      const total = update.numberComponentsTotal ?? componentSet.size;
      const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;
      this.logger?.debug(`Deploy progress: ${pct}% (${deployed}/${total}) — ${update.status}`);
    });

    const result = await deploy.pollStatus();
    return result.response;
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async fetchTestFailures(connection: any, testRunId: string): Promise<string> {
    const query = 'SELECT MethodName, StackTrace, Message, ApexClass.Name '
      + `FROM ApexTestResult WHERE AsyncApexJobId = '${testRunId}' AND Outcome = 'Fail'`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await connection.tooling.query<any>(query);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (result.records ?? []).map((r: any) => `${r.ApexClass?.Name}.${r.MethodName}: ${r.Message}`).join('\n');
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
   * Poll the ApexTestRunResult until the test run completes.
   * Uses recursive scheduling to avoid `await` inside a loop.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async pollTestRun(connection: any, testRunId: string): Promise<any> {
    const pollIntervalMs = 5000;
    const maxAttempts = 360; // 30 minutes

    const query = 'SELECT Status, MethodsCompleted, MethodsFailed, MethodsEnqueued '
      + `FROM ApexTestRunResult WHERE AsyncApexJobId = '${testRunId}'`;

    const poll = async (attempt: number): Promise<any> => {
      if (attempt >= maxAttempts) {
        throw new BuildError(this.sfpmPackage.packageName, `Test run ${testRunId} timed out after 30 minutes`, {
          buildStep: 'validation:test-only',
          context: {buildOrg: this.buildOrg},
        });
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await connection.tooling.query<any>(query);
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
  // Test-only helpers
  // ==========================================================================

  /**
   * Resolve test class names from the package's testClasses metadata.
   * testClasses can be either plain strings or objects with a `name` property.
   */
  private resolveTestClassNames(): string[] {
    const {testClasses} = this.sfpmPackage;
    return testClasses.map(tc => (typeof tc === 'string' ? tc : tc.name));
  }

  /**
   * Test-only mode: run tests via the Apex Test API (no deployment).
   * Coverage is not checked — only pass/fail.
   */
  private async runTestsOnly(packageName: string, testClassNames: string[]): Promise<void> {
    const org = await Org.create({aliasOrUsername: this.buildOrg});
    const connection = org.getConnection();

    this.logger?.info('Running tests in test-only mode (no deployment)');

    const testRunId = await connection.tooling.runTestsAsynchronous({
      classNames: testClassNames.join(','),
    });

    this.logger?.debug(`Test run started: ${testRunId}`);

    const testResult = await this.pollTestRun(connection, testRunId as string);
    const numTestsRun = Number(testResult.MethodsCompleted ?? 0);
    const numFailures = Number(testResult.MethodsFailed ?? 0);
    const numPassed = numTestsRun - numFailures;

    this.emitTestComplete(packageName, {failed: numFailures, passed: numPassed, testCount: numTestsRun});

    if (numFailures > 0) {
      const failures = await this.fetchTestFailures(connection, testRunId as string);
      throw new BuildError(packageName, `${numFailures} Apex test(s) failed:\n${failures}`, {
        buildStep: 'validation:test-only',
        context: {buildOrg: this.buildOrg, numFailures, numTestsRun},
      });
    }

    this.logger?.info(`All ${numPassed} test(s) passed (test-only mode)`);
  }
}
