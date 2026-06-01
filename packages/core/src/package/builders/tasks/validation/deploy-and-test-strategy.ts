import type {DeploySetOptions, MetadataApiDeploy, MetadataApiDeployStatus} from '@salesforce/source-deploy-retrieve';

import {Org} from '@salesforce/core';

import type {Logger} from '../../../../types/logger.js';
import type {SfpmMetadataPackage} from '../../../sfpm-package.js';
import type {
  ComponentError,
  ComponentResult,
  PollOptions,
  TestClassResult,
  TestMethodResult,
  TestResult,
  ValidationContext,
  ValidationResult,
  ValidationStrategy,
} from './types.js';

/**
 * Normalize a Salesforce API response field that may be a single object, an array, or undefined.
 * Salesforce returns a single object when there's one result, an array for multiple, and undefined for none.
 */
export function toArray<T>(value: T | T[] | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Deploys metadata to the build org with `RunSpecifiedTests`, then returns a
 * rich {@link ValidationResult} with deployment, test, and coverage data.
 *
 * Uses SDR's {@link MetadataApiDeploy} for deploy lifecycle management
 * including built-in polling via `pollStatus()`.
 *
 * All validation assertions are handled by the task.
 */
export class DeployAndTestStrategy implements ValidationStrategy {
  public readonly mode = 'deploy' as const;
  private deploy!: MetadataApiDeploy;
  private readonly logger?: Logger;
  private readonly sfpmPackage: SfpmMetadataPackage;
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

  private mapDeployment(response: MetadataApiDeployStatus): ComponentResult {
    const componentFailures = toArray(response.details.componentFailures);
    const errors: ComponentError[] = componentFailures.map(f => ({
      fullName: f.fullName,
      problem: f.problem ?? '',
    }));

    return {
      deployed: response.numberComponentsDeployed,
      errors,
      success: response.success,
      total: response.numberComponentsTotal,
    };
  }

  private mapResult(response: MetadataApiDeployStatus): ValidationResult {
    return {
      deployment: this.mapDeployment(response),
      tests: this.mapTests(response),
    };
  }

  // ==========================================================================
  // Helpers
  // ==========================================================================

  private mapTests(response: MetadataApiDeployStatus): TestResult {
    const {runTestResult} = response.details;
    const numTestsRun = Number(runTestResult?.numTestsRun ?? 0);
    const numFailures = Number(runTestResult?.numFailures ?? 0);

    const classMap = new Map<string, TestMethodResult[]>();

    for (const f of toArray(runTestResult?.failures)) {
      const className = f.name;
      const methods = classMap.get(className) ?? [];
      methods.push({
        message: f.message,
        methodName: f.methodName,
        outcome: 'fail' as const,
        stackTrace: f.stackTrace || undefined,
      });
      classMap.set(className, methods);
    }

    for (const s of toArray(runTestResult?.successes)) {
      const className = s.name;
      const methods = classMap.get(className) ?? [];
      methods.push({
        durationMs: s.time === null || s.time === undefined ? undefined : Number(s.time),
        methodName: s.methodName,
        outcome: 'pass' as const,
      });
      classMap.set(className, methods);
    }

    const rawCoverage = toArray(runTestResult?.codeCoverage);
    const coverageByClass = new Map(rawCoverage.map(c => [
      c.name,
      {totalLines: Number(c.numLocations), uncoveredLines: Number(c.numLocationsNotCovered)},
    ]));

    const results: TestClassResult[] = [];

    for (const [className, methods] of classMap) {
      results.push({
        className,
        coverage: coverageByClass.get(className),
        methods,
      });
    }

    // Add coverage-only classes (production classes with coverage but no test methods)
    for (const [className, coverage] of coverageByClass) {
      if (!classMap.has(className)) {
        results.push({className, coverage, methods: []});
      }
    }

    return {
      failed: numFailures,
      passed: numTestsRun - numFailures,
      results,
      total: numTestsRun,
    };
  }

  private async pollResult(options?: PollOptions): Promise<ValidationResult> {
    let attempt = 0;

    this.deploy.onUpdate(status => {
      attempt++;
      const deployed = status.numberComponentsDeployed;
      const total = status.numberComponentsTotal;
      const pct = total > 0 ? Math.round((deployed / total) * 100) : 0;

      options?.onProgress?.({
        attempt,
        message: `Deploying ${deployed}/${total} components`,
        percentage: pct,
        status: String(status.status),
      });

      this.logger?.debug(`Deploy progress: ${pct}% (${deployed}/${total}) — ${status.status}`);
    });

    const result = await this.deploy.pollStatus();
    return this.mapResult(result.response);
  }

  private async run(testClasses: string[]): Promise<void> {
    const org = await Org.create({aliasOrUsername: this.validationOrg});
    const connection = org.getConnection();

    const componentSet = this.sfpmPackage.getComponentSet();
    const deployOptions: DeploySetOptions = {
      apiOptions: {
        runTests: testClasses,
        testLevel: 'RunSpecifiedTests' as DeploySetOptions['apiOptions'] extends {testLevel?: infer T} ? T : never,
      },
      usernameOrConnection: connection,
    };
    this.deploy = await componentSet.deploy(deployOptions);
  }
}
