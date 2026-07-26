import type {Connection} from '@salesforce/core';

import {Org} from '@salesforce/core';

import type {ScopedValidationSink, ValidationEventBus} from '../../events/index.js';
import type Logger from '../../types/logger.js';
import type {
  PackageVersionValidationDescriptor,
  ResolveOptions,
  ValidationCheck,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/validation.js';

import PackageService, {type PackageVersionCreateRequestResult} from '../package-service.js';

// ============================================================================
// PackageVersionResolver
// ============================================================================

/**
 * Resolves {@link PackageVersionValidationDescriptor}s by polling the DevHub
 * for package version creation status.
 *
 * Groups descriptors by devhub to share org connections, then polls each
 * descriptor concurrently within each group.
 */
export class PackageVersionResolver {
  constructor(
    private readonly logger?: Logger,
    private readonly bus?: ValidationEventBus,
  ) {}

  async resolve(
    descriptors: PackageVersionValidationDescriptor[],
    options: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();
    if (descriptors.length === 0) return results;

    const byDevhub = new Map<string, PackageVersionValidationDescriptor[]>();
    for (const d of descriptors) {
      const group = byDevhub.get(d.devhub) ?? [];
      group.push(d);
      byDevhub.set(d.devhub, group);
    }

    await Promise.all([...byDevhub.entries()].map(async ([devhub, group]) => {
      let org: Org;
      try {
        org = await Org.create({aliasOrUsername: devhub});
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        for (const d of group) {
          results.set(d.packageName, {
            checks: ['dependencies', 'deploy', 'test'],
            error: `Failed to connect to devhub ${devhub}: ${message}`,
            status: 'failed',
          });
        }

        return;
      }

      await Promise.all(group.map(async descriptor => {
        try {
          const report = await PackageService.awaitValidation(
            descriptor.packageVersionRequestId,
            org.getConnection() as Connection,
            {maxWaitMs: options.maxWaitMs, pollingIntervalMs: options.pollingIntervalMs},
            this.logger,
          );
          results.set(descriptor.packageName, this.mapReport(descriptor, report));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const timedOut = (error as {name?: string}).name === 'PackageValidationTimeout';
          this.logger?.[timedOut ? 'error' : 'warn'](`${descriptor.packageName}: ${message}`);
          this.sinkFor(descriptor.packageName)?.failed({error: message});
          results.set(descriptor.packageName, {
            checks: ['dependencies', 'deploy', 'test'],
            error: message,
            status: 'failed',
          });
        }
      }));
    }));

    return results;
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private mapReport(
    descriptor: PackageVersionValidationDescriptor,
    report: PackageVersionCreateRequestResult,
  ): ValidationStateFailed | ValidationStatePassed {
    const checks: ValidationCheck[] = ['dependencies', 'deploy', 'test'];

    if (report.Status === 'Success') {
      const codeCoverage = typeof report.CodeCoverage === 'number' ? report.CodeCoverage : undefined;
      this.logger?.info(`Validation passed for '${descriptor.packageName}' (coverage: ${codeCoverage ?? 'N/A'}%)`);
      this.sinkFor(descriptor.packageName)?.passed({checks, codeCoverage});
      return {checks, status: 'passed', testCoverage: codeCoverage};
    }

    // Status === 'Error'
    const errors = (report.Error as undefined | unknown[])?.length
      ? (report.Error as unknown[]).map(e => typeof e === 'string' ? e : (e as {Message?: string}).Message ?? JSON.stringify(e)).join('; ')
      : 'Unknown error';
    this.logger?.error(`Validation failed for '${descriptor.packageName}': ${errors}`);
    this.sinkFor(descriptor.packageName)?.failed({error: errors});
    return {checks, error: errors, status: 'failed'};
  }

  private sinkFor(packageName: string): ScopedValidationSink | undefined {
    return this.bus?.forPackage(packageName);
  }
}
