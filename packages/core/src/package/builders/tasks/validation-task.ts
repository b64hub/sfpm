import EventEmitter from 'node:events';

import type {TestClassResult, ValidationResult, ValidationStrategy} from './validation/types.js';

import {BuildError} from '../../../types/errors.js';
import {Logger} from '../../../types/logger.js';
import {SfpmMetadataPackage} from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';
import {DeployAndTestStrategy} from './validation/deploy-and-test-strategy.js';
import {TestOnlyStrategy} from './validation/test-only-strategy.js';

export type {ValidationProgress, ValidationResult} from './validation/types.js';

/** Minimum code coverage percentage required for validation to pass. */
export const COVERAGE_THRESHOLD = 75;

export interface ValidationTaskOptions {
  /**
   * Test-only mode: run tests via the Apex Test API without deploying metadata.
   * Used for downstream unchanged packages that still need their tests exercised.
   * In this mode, coverage is not checked — only pass/fail matters.
   */
  testOnly?: boolean;
  warnOnly?: boolean; // TODO: implement warn-only mode that logs validation failures without throwing
}

/**
 * Build task that validates a metadata package against a build org.
 *
 * Delegates to one of two strategies:
 * - {@link DeployAndTestStrategy} (default): deploy metadata, run tests, check 75% coverage
 * - {@link TestOnlyStrategy} (`testOnly: true`): run tests via Tooling API, no deploy or coverage
 *
 * Strategies are pure "fetch and normalize" — they return a {@link ValidationResult}.
 * All validation assertions live here in the task.
 *
 * Throws {@link BuildError} when:
 * - The package contains Apex but has no test classes defined
 * - Deployment failed (component errors)
 * - Any Apex test failed
 * - Code coverage is below the 75% threshold (deploy mode only)
 */
export interface ValidationTaskConfig {
  eventEmitter?: EventEmitter;
  logger?: Logger;
  options?: ValidationTaskOptions;
  sfpmPackage: SfpmMetadataPackage;
  validationOrg: string;
}

export default class ValidationTask implements BuildTask {
  private readonly eventEmitter?: EventEmitter;
  private readonly logger?: Logger;
  private readonly options: ValidationTaskOptions;
  private readonly sfpmPackage: SfpmMetadataPackage;
  private readonly strategy: ValidationStrategy;
  private readonly validationOrg: string;

  public constructor(config: ValidationTaskConfig) {
    this.sfpmPackage = config.sfpmPackage;
    this.validationOrg = config.validationOrg;
    this.logger = config.logger;
    this.eventEmitter = config.eventEmitter;
    this.options = config.options ?? {};

    const ctx = {logger: this.logger, sfpmPackage: this.sfpmPackage, validationOrg: this.validationOrg};
    this.strategy = this.options.testOnly
      ? new TestOnlyStrategy(ctx)
      : new DeployAndTestStrategy(ctx);
  }

  /**
   * Synchronous convenience — starts the validation and polls the result.
   * Equivalent to calling `start()` followed by `poll()`.
   */
  public async exec(): Promise<void> {
    if (!this.sfpmPackage.hasApex) {
      this.logger?.info(`Package '${this.sfpmPackage.packageName}' has no Apex — skipping test validation`);
      return;
    }

    const testClasses = this.guardTestClasses();
    this.emitTestStart(testClasses.length);

    this.logger?.info(`Validating package '${this.sfpmPackage.packageName}' against ${this.validationOrg} [${this.strategy.mode}]`);
    this.logger?.info(`Running ${testClasses.length} test class(es): ${testClasses.join(', ')}`);

    const result = await this.strategy.validate(testClasses, {
      onProgress: progress => {
        this.eventEmitter?.emit('source:test:progress', {
          ...progress,
          packageName: this.sfpmPackage.packageName,
          timestamp: new Date(),
        });
      },
    });

    this.applyResult(result);
  }

  private applyResult(result: ValidationResult): void {
    // 1. Deployment — skip gracefully when absent (test-only mode)
    if (result.deployment) {
      this.assertDeploySuccess(result);
    }

    // 2. Tests — always asserted
    this.assertTestsPassed(result);

    const hasCoverage = result.tests.results.some(c => c.coverage !== undefined);
    if (hasCoverage) {
      const coveragePercentage = calculateCoverage(result.tests.results);
      this.sfpmPackage.testCoverage = coveragePercentage;
      if (!this.options.testOnly) {
        this.assertCoverage(coveragePercentage);
      }
    }

    this.emitTestComplete(result);
    this.logger?.info(`Validation passed for '${this.sfpmPackage.packageName}'`);
  }

  private assertCoverage(coveragePercentage: number): void {
    if (coveragePercentage >= COVERAGE_THRESHOLD) return;

    throw new BuildError(
      this.sfpmPackage.packageName,
      `Code coverage ${coveragePercentage}% is below the required ${COVERAGE_THRESHOLD}%`,
      {
        buildStep: 'validation',
        context: {buildOrg: this.validationOrg, coveragePercentage, coverageRequired: COVERAGE_THRESHOLD},
      },
    );
  }

  private assertDeploySuccess(result: ValidationResult): void {
    const {deployment} = result;
    if (!deployment || deployment.success) return;

    const errorMessages = deployment.errors
    .map(e => `${e.fullName}: ${e.problem}`)
    .join('\n') || 'Unknown deployment error';

    throw new BuildError(this.sfpmPackage.packageName, `Validation deployment failed:\n${errorMessages}`, {
      buildStep: 'validation',
      context: {buildOrg: this.validationOrg},
    });
  }

  private assertTestsPassed(result: ValidationResult): void {
    const {tests} = result;
    if (tests.failed === 0) return;

    const failures: string[] = [];
    for (const testClass of tests.results) {
      for (const testMethod of testClass.methods) {
        if (testMethod.outcome === 'fail') {
          failures.push(`${testClass.className}.${testMethod.methodName}: ${testMethod.message}`);
        }
      }
    }

    throw new BuildError(
      this.sfpmPackage.packageName,
      `${tests.failed} Apex test(s) failed:\n${failures.join('\n')}`,
      {
        buildStep: 'validation',
        context: {
          buildOrg: this.validationOrg,
          numFailures: tests.failed,
          numTestsRun: tests.total,
        },
      },
    );
  }

  // ==========================================================================
  // Events
  // ==========================================================================

  private emitTestComplete(result: ValidationResult): void {
    const coveragePercentage = this.sfpmPackage.testCoverage;
    this.eventEmitter?.emit('source:test:complete', {
      coveragePercentage,
      coverageRequired: coveragePercentage === undefined ? undefined : COVERAGE_THRESHOLD,
      failed: result.tests.failed,
      packageName: this.sfpmPackage.packageName,
      passed: result.tests.passed,
      testCount: result.tests.total,
      timestamp: new Date(),
    });
  }

  private emitTestStart(testCount: number): void {
    this.eventEmitter?.emit('source:test:start', {
      packageName: this.sfpmPackage.packageName,
      testCount,
      testLevel: 'RunSpecifiedTests',
      timestamp: new Date(),
    });
  }

  private guardTestClasses(): string[] {
    const testClassNames = this.sfpmPackage.testClasses.map(tc => (typeof tc === 'string' ? tc : tc.name));

    if (testClassNames.length === 0) {
      throw new BuildError(this.sfpmPackage.packageName, 'Package contains Apex but has no test classes defined', {
        buildStep: 'validation',
      });
    }

    return testClassNames;
  }
}

/**
 * Calculate overall code coverage percentage from test class results.
 * Only considers classes that have coverage data.
 * Returns 0 when no coverage data is available or total lines is zero.
 */
function calculateCoverage(classes: TestClassResult[]): number {
  const withCoverage = classes.filter(c => c.coverage !== undefined);
  if (withCoverage.length === 0) return 0;

  let totalLines = 0;
  let coveredLines = 0;

  for (const cls of withCoverage) {
    const total = Number(cls.coverage!.totalLines ?? 0);
    const uncovered = Number(cls.coverage!.uncoveredLines ?? 0);
    totalLines += total;
    coveredLines += total - uncovered;
  }

  if (totalLines === 0) return 0;
  return Math.round((coveredLines / totalLines) * 100);
}
