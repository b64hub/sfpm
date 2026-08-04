import type {
  AvailabilityResult,
  BaseValidationContext,
  CompileContext,
  DependencyContext,
  DependencyResult,
  LocalValidator,
  TestContext,
  ValidationResult,
} from '@b64hub/sfpm-core';

import type {NimbusAdapterDeps} from './config.js';

import {findPackageBoundaryViolations} from '../../boundary-check/find-boundary-violations.js';
import {
  buildOwnershipIndex,
  type MetadataOwnership,
  type PackageManifest,
} from '../../boundary-check/metadata-ownership-index.js';
import {NimbusGraphProvider} from './nimbus-graph-provider.js';
import {createNimbusValidator} from './nimbus-validator.js';

/**
 * Nimbus implementation of the {@link LocalValidator} port.
 *
 * Composes three Nimbus capabilities behind one interface:
 *   compile          → `nimbus validate`
 *   test             → `nimbus test`
 *   checkDependencies → `nimbus graph` + boundary-violation analysis
 *
 * The ownership index is built from `manifests` once at construction time,
 * so all per-package `checkDependencies` calls share a single warm index.
 */
export class NimbusLocalValidator implements LocalValidator {
  private readonly graphProvider: NimbusGraphProvider;
  private readonly manifestByPackageId: Map<string, PackageManifest>;
  private readonly ownershipIndex: Map<string, MetadataOwnership>;
  private readonly validator: ReturnType<typeof createNimbusValidator>;

  constructor(deps: NimbusAdapterDeps, manifests: PackageManifest[]) {
    this.graphProvider       = new NimbusGraphProvider(deps);
    this.validator           = createNimbusValidator(deps);
    this.ownershipIndex      = buildOwnershipIndex(manifests);
    this.manifestByPackageId = new Map(manifests.map(m => [m.packageId, m]));
  }

  async checkAvailability(context: Pick<BaseValidationContext, 'packageId'>): Promise<AvailabilityResult> {
    return this.validator.checkAvailability(context);
  }

  async checkDependencies(context: DependencyContext): Promise<DependencyResult> {
    const start = Date.now();
    const pkg = this.manifestByPackageId.get(context.packageId);

    if (!pkg) {
      return {
        caveats: [], durationMs: 0, status: 'skipped', unresolved: [], violations: [],
      };
    }

    try {
      const result = await findPackageBoundaryViolations(
        pkg,
        this.ownershipIndex,
        this.graphProvider,
        context,
      );
      return {
        caveats: result.caveats,
        durationMs: Date.now() - start,
        status: result.violations.length > 0 ? 'failed' : 'passed',
        unresolved: result.unresolved,
        violations: result.violations,
      };
    } catch {
      return {
        caveats: [],
        durationMs: Date.now() - start,
        status: 'error',
        unresolved: [],
        violations: [],
      };
    }
  }

  async compile(context: CompileContext): Promise<ValidationResult> {
    const r = await this.validator.run('compile', context);
    return {
      diagnostics: r.diagnostics, durationMs: r.durationMs, raw: r.raw, status: r.status,
    };
  }

  async test(context: TestContext): Promise<ValidationResult> {
    const r = await this.validator.run('test', context);
    return {
      diagnostics: r.diagnostics, durationMs: r.durationMs, raw: r.raw, status: r.status,
    };
  }
}
