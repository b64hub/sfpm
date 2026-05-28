import type {
  TestResult as ApexTestResult,
  TestRunIdResult,
} from '@salesforce/apex-node';

import {TestLevel, TestService} from '@salesforce/apex-node';
import {Org} from '@salesforce/core';

import type {Logger} from '../../../../types/logger.js';
import type {SfpmMetadataPackage} from '../../../sfpm-package.js';
import type {
  PollOptions,
  TestClassResult,
  TestMethodResult,
  ValidationContext,
  ValidationResult,
  ValidationStrategy,
} from './types.js';

import {BuildError} from '../../../../types/errors.js';

/**
 * Runs Apex tests via {@link TestService} from `@salesforce/apex-node`
 * without deploying metadata.
 *
 * The SDK handles test enqueue, polling, and coverage queries internally.
 * This strategy just maps the SDK's {@link ApexTestResult} to our
 * canonical {@link ValidationResult}.
 *
 * Used for downstream unchanged packages that still need their tests exercised
 * against the current build org state. Returns a {@link ValidationResult} with
 * `tests` populated (no `deployment`).
 *
 * Only throws {@link BuildError} for infrastructure errors (timeout, failed to start).
 */
export class TestOnlyStrategy implements ValidationStrategy {
  public readonly mode = 'test-only' as const;
  private readonly logger?: Logger;
  private readonly sfpmPackage: SfpmMetadataPackage;
  private testRunId?: string;
  private testService!: TestService;
  private readonly validationOrg: string;

  constructor({logger, sfpmPackage, validationOrg}: ValidationContext) {
    this.validationOrg = validationOrg;
    this.logger = logger;
    this.sfpmPackage = sfpmPackage;
  }

  public async validate(testClasses: string[], options?: PollOptions): Promise<ValidationResult> {
    await this.run(testClasses);
    return this.pollResult(options);
  }

  private mapResult(apexResult: ApexTestResult): ValidationResult {
    // Group test methods by class
    const classMap = new Map<string, TestMethodResult[]>();

    for (const testResult of apexResult.tests) {
      const className = testResult.apexClass.name;
      const methods = classMap.get(className) ?? [];
      methods.push({
        durationMs: testResult.runTime === null || testResult.runTime === undefined ? undefined : testResult.runTime * 1000,
        message: testResult.message ?? undefined,
        methodName: testResult.methodName,
        outcome: testResult.outcome === 'Fail' || testResult.outcome === 'CompileFail' ? 'fail' as const : 'pass' as const,
        stackTrace: testResult.stackTrace ?? undefined,
      });
      classMap.set(className, methods);
    }

    // Build coverage lookup from SDK
    const coverageByClass = new Map((apexResult.codecoverage ?? []).map(c => [
      c.name,
      {totalLines: c.numLinesCovered + c.numLinesUncovered, uncoveredLines: c.numLinesUncovered},
    ]));

    // Merge into TestClassResult[]
    const results: TestClassResult[] = [];

    for (const [className, methods] of classMap) {
      results.push({
        className,
        coverage: coverageByClass.get(className),
        methods,
      });
    }

    // Add coverage-only classes (production classes with no test methods named after them)
    for (const [className, coverage] of coverageByClass) {
      if (!classMap.has(className)) {
        results.push({className, coverage, methods: []});
      }
    }

    return {
      tests: {
        failed: apexResult.summary.failing,
        passed: apexResult.summary.passing,
        results,
        total: apexResult.summary.testsRan,
      },
    };
  }

  private async pollResult(_options?: PollOptions): Promise<ValidationResult> {
    if (!this.testRunId) {
      throw new Error('Test run has not been started.');
    }

    const apexResult = await this.testService.reportAsyncResults(this.testRunId, true);
    return this.mapResult(apexResult as ApexTestResult);
  }

  private async run(testClasses: string[]): Promise<void> {
    const org = await Org.create({aliasOrUsername: this.validationOrg});
    const connection = org.getConnection();
    this.testService = new TestService(connection);

    try {
      const payload = await this.testService.buildAsyncPayload(
        TestLevel.RunSpecifiedTests,
        undefined,
        testClasses.join(','),
      );

      const result = await this.testService.runTestAsynchronous(
        payload,
        false,
        true, // immediatelyReturn — just get the testRunId
      );

      this.testRunId = (result as TestRunIdResult).testRunId;
    } catch (error) {
      throw new BuildError(this.sfpmPackage.packageName, `Failed to start test run: ${(error as Error).message}`, {
        buildStep: 'validation:test-only',
        cause: error as Error,
        context: {testClasses, validationOrg: this.validationOrg},
      });
    }
  }
}
