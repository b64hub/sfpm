import {Org} from '@salesforce/core';

import type {ProjectDefinitionProvider} from '../../project/providers/project-definition-provider.js';
import type Logger from '../../types/logger.js';
import type {
  DeployValidationDescriptor,
  ResolveOptions,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/validation.js';

import {type InstallOrchestrationResult, InstallOrchestrator} from '../../orchestrator/install-orchestrator.js';
import {ProjectGraph} from '../../project/project-graph.js';

// ============================================================================
// Types
// ============================================================================

export interface DeployValidationResult {
  /**
   * Results for upstream dependencies installed as side-effects of orchestration.
   * Informational only — not persisted. Pessimistic merge applied across orgs
   * (a failure in any org wins over a pass in another).
   */
  incidental: Map<string, ValidationStateFailed | ValidationStatePassed>;
  /**
   * Results for packages explicitly requested in the descriptor set.
   * Authoritative — these are persisted and returned to the caller.
   * Pessimistic merge applied when the same package appears in multiple org groups.
   */
  primary: Map<string, ValidationStateFailed | ValidationStatePassed>;
}

// ============================================================================
// DeployValidationResolver
// ============================================================================

/**
 * Resolves {@link DeployValidationDescriptor}s by running install orchestration
 * per target org in parallel.
 *
 * Separates orchestration results into two buckets:
 * - `primary`    — packages explicitly in the descriptor set
 * - `incidental` — upstream dependencies pulled in by the orchestrator
 *
 * Both buckets use pessimistic merge: a failure in any org beats a prior pass.
 */
export class DeployValidationResolver {
  constructor(
    private readonly provider: ProjectDefinitionProvider,
    private readonly graph: ProjectGraph,
    private readonly logger?: Logger,
  ) {}

  async resolve(
    descriptors: DeployValidationDescriptor[],
    options: ResolveOptions,
  ): Promise<DeployValidationResult> {
    const primary = new Map<string, ValidationStateFailed | ValidationStatePassed>();
    const incidental = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    if (descriptors.length === 0) return {incidental, primary};

    const requestedPackages = new Set(descriptors.map(d => d.packageName));

    const byTargetOrg = new Map<string, DeployValidationDescriptor[]>();
    for (const d of descriptors) {
      const group = byTargetOrg.get(d.targetOrg) ?? [];
      group.push(d);
      byTargetOrg.set(d.targetOrg, group);
    }

    await Promise.all([...byTargetOrg.entries()].map(async ([targetOrgAlias, group]) => {
      const orgLogger = this.logger?.child?.({targetOrg: targetOrgAlias}) ?? this.logger;
      const groupPackageNames = group.map(d => d.packageName);

      orgLogger?.info(`Deploy validation: installing ${groupPackageNames.length} package(s) to ${targetOrgAlias}`);

      const orgResults = await this.runOrgInstall(targetOrgAlias, groupPackageNames, options, orgLogger);

      for (const [name, result] of orgResults) {
        // Pessimistic merge: failed in any org beats passed in another
        const bucket = requestedPackages.has(name) ? primary : incidental;
        const existing = bucket.get(name);
        if (!existing || (existing.status === 'passed' && result.status === 'failed')) {
          bucket.set(name, result);
        }
      }
    }));

    return {incidental, primary};
  }

  // ========================================================================
  // Per-org install
  // ========================================================================

  private async runOrgInstall(
    targetOrgAlias: string,
    packageNames: string[],
    options: ResolveOptions,
    logger?: Logger,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    let targetOrg: Org;
    try {
      targetOrg = await Org.create({aliasOrUsername: targetOrgAlias});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of packageNames) {
        results.set(name, {checks: ['deploy'], error: `Failed to connect to org ${targetOrgAlias}: ${message}`, status: 'failed'});
      }

      return results;
    }

    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg,
      this.provider,
      this.graph,
      {includeDependencies: true, regressionTest: options.regressionTest},
      logger,
    );

    let orchestrationResult: InstallOrchestrationResult;
    try {
      orchestrationResult = await orchestrator.installAll(packageNames);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      for (const name of packageNames) {
        results.set(name, {checks: ['deploy'], error: `Install orchestration failed: ${message}`, status: 'failed'});
      }

      return results;
    }

    for (const pkgResult of orchestrationResult.results) {
      results.set(
        pkgResult.packageName,
        pkgResult.success
          ? {checks: ['deploy'], status: 'passed'}
          : {checks: ['deploy'], error: pkgResult.error ?? 'Installation failed', status: 'failed'},
      );
    }

    return results;
  }
}
