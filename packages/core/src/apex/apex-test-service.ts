import type {
  TestResult as ApexTestResult,
  TestRunIdResult,
} from '@salesforce/apex-node';

import {TestLevel, TestService} from '@salesforce/apex-node';
import {Org} from '@salesforce/core';

import type {Logger} from '../types/logger.js';

// ============================================================================
// Types
// ============================================================================

/** Per-method test result with optional timing. */
export interface TestMethodResult {
  durationMs?: number;
  message?: string;
  methodName: string;
  outcome: 'fail' | 'pass' | 'skip';
  stackTrace?: string;
}

/** Coverage data for a single class or trigger. */
export interface ClassCoverage {
  totalLines: number;
  uncoveredLines: number;
}

/** Per-class test result grouping methods and coverage. */
export interface TestClassResult {
  className: string;
  coverage?: ClassCoverage;
  methods: TestMethodResult[];
}

/** Aggregate test run results. */
export interface TestRunResult {
  failed: number;
  passed: number;
  results: TestClassResult[];
  total: number;
}

/** Options for running tests. */
export interface RunTestsOptions {
  /** Test level — defaults to RunSpecifiedTests when testClasses provided */
  testLevel?: 'RunLocalTests' | 'RunSpecifiedTests';
}

// ============================================================================
// ApexTestService
// ============================================================================

/**
 * Low-level service for running Apex tests against a Salesforce org.
 *
 * Package-agnostic — operates on test class names and an org alias.
 * Provides both fire-and-forget (returns testRunId) and await (polls for result) APIs.
 *
 * @example
 * ```ts
 * const service = new ApexTestService(logger);
 * const testRunId = await service.runTests('my-org', ['MyTestClass']);
 * const result = await service.awaitTests(testRunId, 'my-org');
 * ```
 */
export class ApexTestService {
  private readonly logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * Wait for a previously started test run to complete and return results.
   * Polls the Salesforce API until tests finish.
   */
  async awaitTests(
    testRunId: string,
    targetOrg: string,
  ): Promise<TestRunResult> {
    const org = await Org.create({aliasOrUsername: targetOrg});
    const connection = org.getConnection();
    const testService = new TestService(connection);

    this.logger?.info(`Awaiting test run ${testRunId} on ${targetOrg}`);
    const apexResult = await testService.reportAsyncResults(testRunId, true);

    return this.mapResult(apexResult as ApexTestResult);
  }

  /**
   * Start an async Apex test run and return the test run ID immediately.
   * The tests continue server-side — use {@link awaitTests} to get results.
   */
  async runTests(
    targetOrg: string,
    testClasses: string[],
    _options?: RunTestsOptions,
  ): Promise<string> {
    const org = await Org.create({aliasOrUsername: targetOrg});
    const connection = org.getConnection();
    const testService = new TestService(connection);

    const payload = await testService.buildAsyncPayload(
      TestLevel.RunSpecifiedTests,
      undefined,
      testClasses.join(','),
    );

    const result = await testService.runTestAsynchronous(
      payload,
      false,
      true, // immediatelyReturn — just get the testRunId
    );

    const {testRunId} = (result as TestRunIdResult);
    this.logger?.info(`Test run started: ${testRunId} against ${targetOrg} (${testClasses.length} classes)`);

    return testRunId;
  }

  private mapResult(apexResult: ApexTestResult): TestRunResult {
    const classMap = new Map<string, TestMethodResult[]>();

    for (const testResult of apexResult.tests) {
      const className = testResult.apexClass.name;
      const methods = classMap.get(className) ?? [];
      methods.push({
        durationMs: testResult.runTime === null ? undefined : testResult.runTime * 1000,
        message: testResult.message ?? undefined,
        methodName: testResult.methodName,
        outcome: testResult.outcome === 'Fail' || testResult.outcome === 'CompileFail' ? 'fail' : 'pass',
        stackTrace: testResult.stackTrace ?? undefined,
      });
      classMap.set(className, methods);
    }

    const coverageByClass = new Map((apexResult.codecoverage ?? []).map(c => [
      c.name,
      {totalLines: c.numLinesCovered + c.numLinesUncovered, uncoveredLines: c.numLinesUncovered},
    ]));

    const results: TestClassResult[] = [];

    for (const [className, methods] of classMap) {
      results.push({
        className,
        coverage: coverageByClass.get(className),
        methods,
      });
    }

    // Add coverage-only classes (production classes covered by tests but not having test methods named after them)
    for (const [className, coverage] of coverageByClass) {
      if (!classMap.has(className)) {
        results.push({className, coverage, methods: []});
      }
    }

    return {
      failed: apexResult.summary.failing,
      passed: apexResult.summary.passing,
      results,
      total: apexResult.summary.testsRan,
    };
  }
}
