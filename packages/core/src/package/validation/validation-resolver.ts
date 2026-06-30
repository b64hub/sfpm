import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';
import fs from 'node:fs';

import type {ScopedValidationSink, ValidationEventBus, ValidationEventSink} from '../../events/index.js';
import type Logger from '../../types/logger.js';
import type {
  PendingValidationDescriptor,
  ValidationCheck,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/validation.js';

import {type DeployResult, MetadataDeployService} from '../../tooling/metadata-deploy-service.js';
import {type PackageValidationResult, ValidationPoller} from './validation-poller.js';

/** Terminal validation result tagged with the originating package name. */
interface PackageValidationOutcome {
  packageName: string;
  result: ValidationStateFailed | ValidationStatePassed;
}

// ============================================================================
// Types
// ============================================================================

/** Default coverage threshold when resolving deploy-based validations. */
const DEFAULT_COVERAGE_THRESHOLD = 75;

export interface ResolveOptions {
  /** Minimum code coverage percentage required (default: 75) */
  coverageThreshold?: number;
  /** Maximum time to wait for resolution in milliseconds (default: 7_200_000 = 120 min) */
  maxWaitMs?: number;
  /** Polling interval in milliseconds (default: 30_000 = 30s) */
  pollingIntervalMs?: number;
}

const PENDING_VALIDATIONS_FILE = 'pending-validations.json';

class ValidationCache {
  data: Map<string, PendingValidationDescriptor> = new Map();
  projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  public add(descriptor: PendingValidationDescriptor): void {
    this.data.set(descriptor.packageName, descriptor);
  }

  public async read(): Promise<Map<string, PendingValidationDescriptor>> {
    const data = await fs.promises.readFile(`${this.projectRoot}/.sfpm/${PENDING_VALIDATIONS_FILE}`, 'utf8');
    const parsed = JSON.parse(data) as Record<string, PendingValidationDescriptor>;
    this.data = new Map(Object.entries(parsed));
    return this.data;
  }

  public remove(packageName: string): void {
    this.data.delete(packageName);
  }

  public async write(): Promise<void> {
    const data = JSON.stringify(Object.fromEntries(this.data), null, 2);
    await fs.promises.writeFile(`${this.projectRoot}/.sfpm/${PENDING_VALIDATIONS_FILE}`, data, 'utf8');
  }
}

// ============================================================================
// ValidationResolver
// ============================================================================

/**
 * Resolves pending validation operations into a final {@link ValidationState}.
 *
 * Routes by `operationType`:
 * - `'package-version-request'` — polls the DevHub for unlocked package creation status
 * - `'deploy'` — awaits a metadata deployment for completion, checks test results + coverage
 *
 * This service composes {@link ValidationPoller} (for unlocked packages) and
 * {@link MetadataDeployService} (for source packages) to provide a unified
 * resolution contract.
 *
 * Accepts an optional {@link ValidationEventSink} for progress reporting.
 * When provided, the resolver emits lifecycle events that renderers can
 * subscribe to for real-time UI feedback.
 *
 * @example
 * ```ts
 * const bus = new ValidationEventBus();
 * const resolver = new ValidationResolver(logger, bus);
 * renderer.attachTo(bus);
 * const results = await resolver.resolve(descriptors);
 * ```
 */
export class ValidationResolver {
  private readonly bus?: ValidationEventBus;
  private readonly logger?: Logger;
  private readonly options?: ResolveOptions;
  private orgConnections: Map<string, Org> = new Map();
  private readonly sink?: ValidationEventSink;

  constructor(logger?: Logger, bus?: ValidationEventBus, options?: ResolveOptions) {
    this.logger = logger;
    this.bus = bus;
    this.options = options;
  }

  /**
   * Resolve multiple pending validations with optimal concurrency.
   *
   * - Deploy-type descriptors are resolved sequentially (they target the same org).
   * - Package-version-request descriptors are resolved in parallel (independent server-side).
   */
  async resolve(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const packageNames = descriptors.map(d => d.packageName);
    this.sink?.start({packageNames});

    this.logger?.info(`Resolving ${descriptors.length} pending validation(s): ${packageNames.join(', ')}`);

    await this.resolveOrgs(descriptors);
    this.logger?.debug(`Connected orgs: ${[...this.orgConnections.keys()].join(', ')}`);

    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    try {
      const deployDescriptors = descriptors.filter(d => d.operationType === 'deploy');
      const packageVersionDescriptors = descriptors.filter(d => d.operationType === 'package-version-request');

      await Promise.all([
        this.resolveSequentially(deployDescriptors).then(resolved => {
          for (const [packageName, result] of resolved) {
            results.set(packageName, result);
          }
        }),
        this.resolveInParallel(packageVersionDescriptors).then(resolved => {
          for (const [packageName, result] of resolved) {
            results.set(packageName, result);
          }
        }),
      ]);
    } finally {
      const passed = [...results.values()].filter(r => r.status === 'passed').length;
      const failed = [...results.values()].filter(r => r.status === 'failed').length;

      this.sink?.complete({
        failed, passed, timedOut: 0, total: results.size,
      });
    }

    return results;
  }

  private getOrg(descriptor: PendingValidationDescriptor): Org {
    const org = this.orgConnections.get(descriptor.targetOrg);
    if (!org) {
      throw new Error(`Org not connected for '${descriptor.packageName}' (${descriptor.targetOrg})`);
    }

    return org;
  }

  private getResolver(descriptor: PendingValidationDescriptor): PackageValidationResolver {
    switch (descriptor.operationType) {
    case 'deploy': {
      return new DeployResolver(this.logger, this.sinkFor(descriptor.packageName), this.options);
    }

    case 'package-version-request': {
      return new PackageVersionRequestResolver(this.logger, this.sinkFor(descriptor.packageName), this.options);
    }

    default: {
      throw new Error(`Unknown operation type '${descriptor.operationType}' for '${descriptor.packageName}'`);
    }
    }
  }

  private async resolveInParallel(descriptors: PendingValidationDescriptor[]): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results: Map<string, ValidationStateFailed | ValidationStatePassed> = new Map();
    const promises = descriptors.map(async descriptor => {
      const result = await this.resolveSingle(descriptor);
      results.set(descriptor.packageName, result);
    });

    await Promise.all(promises);
    return results;
  }

  private async resolveOrgs(descriptors: PendingValidationDescriptor[]): Promise<void> {
    await Promise.all(descriptors.map(async descriptor => {
      const username = descriptor.targetOrg;
      if (!this.orgConnections.has(username)) {
        const org = await Org.create({aliasOrUsername: username});
        this.orgConnections.set(username, org);
      }
    }));
  }

  private async resolveSequentially(descriptors: PendingValidationDescriptor[]): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results: Map<string, ValidationStateFailed | ValidationStatePassed> = new Map();

    for (const descriptor of descriptors) {
      // eslint-disable-next-line no-await-in-loop -- Sequential resolution is required for deploys to the same org
      results.set(descriptor.packageName, await this.resolveSingle(descriptor));
    }

    return results;
  }

  private resolveSingle(descriptor: PendingValidationDescriptor): Promise<ValidationStateFailed | ValidationStatePassed> {
    const resolver = this.getResolver(descriptor);
    try {
      resolver.connect(this.getOrg(descriptor));
      return resolver.resolve(descriptor);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.debug(`Validation resolution error for '${descriptor.packageName}': ${message}`);

      const failed: ValidationStateFailed = {
        checks: resolver.checks,
        error: message,
        status: 'failed',
      };
      return Promise.resolve(failed);
    }
  }

  /**
   * Create a package-scoped validation sink, or `undefined` if no bus is wired.
   */
  private sinkFor(packageName: string): ScopedValidationSink | undefined {
    return this.bus?.forPackage(packageName);
  }
}

interface PackageValidationResolver {
  checks: ValidationCheck[];
  connect(validationOrg: Org): void;
  resolve(descriptor: PendingValidationDescriptor): Promise<ValidationStateFailed | ValidationStatePassed>;
}

class PackageVersionRequestResolver implements PackageValidationResolver {
  public checks: ValidationCheck[] = ['dependencies', 'deploy', 'test'];
  logger?: Logger;
  options?: ResolveOptions;
  sink?: ScopedValidationSink;
  validationOrg?: Org;

  constructor(logger?: Logger, sink?: ScopedValidationSink, options?: ResolveOptions) {
    this.logger = logger;
    this.sink = sink;
    this.options = options;
  }

  public connect(validationOrg: Org): void {
    this.validationOrg = validationOrg;
  }

  public async resolve(descriptor: PendingValidationDescriptor): Promise<ValidationStateFailed | ValidationStatePassed> {
    if (!this.validationOrg) {
      throw new Error('Devhub org not connected');
    }

    this.sink?.status({status: 'polling'});

    try {
      this.logger?.debug(`Awaiting package version request '${descriptor.operationId}' for '${descriptor.packageName}'`);
      const poller = new ValidationPoller(this.validationOrg!.getConnection() as Connection, {
        maxWaitMs: this.options?.maxWaitMs,
        pollingIntervalMs: this.options?.pollingIntervalMs,
      }, this.logger);

      const result: PackageValidationResult = await poller.pollOne({
        packageName: descriptor.packageName,
        packageVersionCreateRequestId: descriptor.operationId,
      });

      return this.evaluateResult(result, descriptor.packageName);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)) ?? 'Package version create failed';
      this.logger?.debug(`Package version create error for '${descriptor.packageName}': ${message}`);

      const failed: ValidationStateFailed = {
        checks: this.checks,
        error: message,
        status: 'failed',
      };

      this.sink?.failed({error: message ?? 'Package version create failed'});
      return failed;
    }
  }

  /**
   * Route a single descriptor to the appropriate resolution strategy.
   */
  private async evaluateResult(
    result: PackageValidationResult,
    packageName: string,
  ): Promise<ValidationStateFailed | ValidationStatePassed> {
    if (result.status !== 'Success') {
      this.logger?.debug(`Validation failed for '${packageName}' (coverage: ${result.codeCoverage ?? 'N/A'}%)`);
      this.sink?.failed({error: result.error ?? `Validation ${result.status.toLowerCase()}`});
      return {
        checks: this.checks,
        error: result.error ?? `Validation ${result.status.toLowerCase()}`,
        status: 'failed',
        testCoverage: result.codeCoverage,
      };
    }

    this.logger?.debug(`Validation passed for '${packageName}' (coverage: ${result.codeCoverage ?? 'N/A'}%)`);
    this.sink?.passed({checks: this.checks, codeCoverage: result.codeCoverage});
    return {
      checks: this.checks,
      status: 'passed',
      testCoverage: result.codeCoverage,
    };
  }
}

class DeployResolver implements PackageValidationResolver {
  public checks: ValidationCheck[] = ['deploy', 'test'];
  logger?: Logger;
  options?: ResolveOptions;
  sink?: ScopedValidationSink;
  validationOrg?: Org;

  constructor(logger?: Logger, sink?: ScopedValidationSink, options?: ResolveOptions) {
    this.logger = logger;
    this.sink = sink;
    this.options = options;
  }

  public connect(validationOrg: Org): void {
    this.validationOrg = validationOrg;
  }

  async resolve(descriptor: PendingValidationDescriptor): Promise<ValidationStateFailed | ValidationStatePassed> {
    if (!this.validationOrg) {
      throw new Error('Validation org not connected for deploy resolution');
    }

    this.sink?.status({status: 'polling'});

    try {
      this.logger?.debug(`Awaiting deploy '${descriptor.operationId}' for '${descriptor.packageName}'`);

      const deployService = new MetadataDeployService(this.validationOrg!, this.logger);
      const result = await deployService.awaitDeploy(descriptor.operationId);

      return this.evaluateResult(result, descriptor.packageName);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)) ?? 'Deploy validation failed';
      this.logger?.debug(`Deploy validation resolution error for '${descriptor.packageName}': ${message}`);

      const failed: ValidationStateFailed = {
        checks: this.checks,
        error: message,
        status: 'failed',
      };

      this.sink?.failed({error: message});
      return failed;
    }
  }

  private evaluateResult(
    result: DeployResult,
    packageName: string,
  ): ValidationStateFailed | ValidationStatePassed {
    const coverageThreshold = this.options?.coverageThreshold ?? DEFAULT_COVERAGE_THRESHOLD;

    const componentFields = {
      componentsDeployed: result.deployed,
      componentsTotal: result.total,
    };

    if (!result.success) {
      this.logger?.debug(`Validation failed for '${packageName}' (coverage: ${result.testResults?.coverage ?? 'N/A'}%)`);
      this.sink?.failed({codeCoverage: result.testResults?.coverage, error: result.formatErrors() || 'Unknown deployment error'});
      return {
        ...componentFields,
        checks: ['deploy'],
        error: result.formatErrors() || 'Unknown deployment error',
        status: 'failed',
      };
    }

    if (result.hasTestFailures()) {
      const failureDetails = result.testResults!.failures
      .map(f => `${f.name}.${f.methodName}: ${f.message}`)
      .join('\n');

      this.logger?.debug(`Validation failed for '${packageName}: Test failures (${result.testResults!.failed} failed, ${result.testResults!.passed} passed, coverage: ${result.testResults!.coverage ?? 'N/A'}%)\n${failureDetails}`);
      this.sink?.failed({codeCoverage: result.testResults!.coverage, error: `${result.testResults!.failed} Apex test(s) failed`});
      return {
        ...componentFields,
        checks: this.checks,
        error: `${result.testResults!.failed} Apex test(s) failed:\n${failureDetails}`,
        status: 'failed',
        testCoverage: result.testResults!.coverage,
      };
    }

    if (!result.meetsCoverageThreshold(coverageThreshold)) {
      this.logger?.debug(`Validation failed for '${packageName}': Coverage ${result.testResults!.coverage}% is below required ${coverageThreshold}%`);
      this.sink?.failed({codeCoverage: result.testResults!.coverage, error: `Coverage ${result.testResults!.coverage}% is below required ${coverageThreshold}%`});
      return {
        ...componentFields,
        checks: this.checks,
        error: `Coverage ${result.testResults!.coverage}% is below required ${coverageThreshold}%`,
        status: 'failed',
        testCoverage: result.testResults!.coverage,
      };
    }

    this.logger?.info(`Validation passed for '${packageName}' (coverage: ${result.testResults?.coverage ?? 'N/A'}%)`);
    this.sink?.passed({...componentFields, checks: this.checks, codeCoverage: result.testResults?.coverage});
    return {
      ...componentFields,
      checks: this.checks,
      status: 'passed',
      testCoverage: result.testResults?.coverage,
    };
  }
}
