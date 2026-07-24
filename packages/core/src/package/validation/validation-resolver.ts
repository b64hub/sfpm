import type {ValidationEventBus} from '../../events/index.js';
import type {ProjectDefinitionProvider} from '../../project/providers/project-definition-provider.js';
import type Logger from '../../types/logger.js';
import type {
  DeployValidationDescriptor,
  PackageVersionValidationDescriptor,
  PendingValidationDescriptor,
  ResolveOptions,
  ValidationStateFailed,
  ValidationStatePassed,
} from '../../types/validation.js';

import {ArtifactRepository} from '../../artifacts/artifact-repository.js';
import {ProjectGraph} from '../../project/project-graph.js';
import {DeployValidationResolver} from './deploy-validation-resolver.js';
import {PackageVersionResolver} from './package-version-resolver.js';

// ============================================================================
// ValidationResolver
// ============================================================================

/**
 * Resolves pending validation operations into a final {@link ValidationState}.
 *
 * Routes by `operationType`:
 * - `'deploy'` — delegates to {@link DeployValidationResolver}, which runs
 *   install orchestration per target org in parallel.
 * - `'package-version-request'` — delegates to {@link PackageVersionResolver},
 *   which polls the DevHub for package creation status.
 *
 * Both paths run concurrently. Results are persisted to each package's artifact
 * metadata, filtered to the descriptor set (upstream dependencies that the
 * orchestrator installs as side-effects are logged but not persisted).
 *
 * @example
 * ```ts
 * const resolver = new ValidationResolver(provider, graph, logger, bus);
 * const results = await resolver.resolve(descriptors, { regressionTest: true });
 * ```
 */
export class ValidationResolver {
  private readonly bus?: ValidationEventBus;
  private readonly graph: ProjectGraph;
  private readonly logger?: Logger;
  private readonly options?: ResolveOptions;
  private readonly provider: ProjectDefinitionProvider;

  constructor(
    provider: ProjectDefinitionProvider,
    graph: ProjectGraph,
    logger?: Logger,
    bus?: ValidationEventBus,
    options?: ResolveOptions,
  ) {
    this.provider = provider;
    this.graph = graph;
    this.logger = logger;
    this.bus = bus;
    this.options = options;
  }

  /**
   * Resolve pending validations.
   *
   * - Deploy descriptors are validated via install orchestration (one per target org, in parallel).
   * - Package-version-request descriptors are polled in parallel.
   * - Both paths run concurrently.
   *
   * Returns results scoped to the requested descriptor set only. Upstream
   * dependencies installed as side-effects are logged at debug level.
   */
  async resolve(
    descriptors: PendingValidationDescriptor[],
    options?: ResolveOptions,
  ): Promise<Map<string, ValidationStateFailed | ValidationStatePassed>> {
    const mergedOptions: ResolveOptions = {...this.options, ...options};
    const packageNames = descriptors.map(d => d.packageName);

    this.bus?.start({packageNames});
    this.logger?.info(`Resolving ${descriptors.length} validation(s): ${packageNames.join(', ')}`);

    const deployDescriptors = descriptors.filter((d): d is DeployValidationDescriptor => d.operationType === 'deploy');
    const packageVersionDescriptors = descriptors.filter((d): d is PackageVersionValidationDescriptor => d.operationType === 'package-version-request');

    const results = new Map<string, ValidationStateFailed | ValidationStatePassed>();

    try {
      const deployResolver = new DeployValidationResolver(this.provider, this.graph, this.logger);
      const packageVersionResolver = new PackageVersionResolver(this.logger, this.bus);

      await Promise.all([
        deployResolver.resolve(deployDescriptors, mergedOptions).then(({incidental, primary}) => {
          for (const [name, result] of primary) results.set(name, result);
          this.logIncidental(incidental);
        }),
        packageVersionResolver.resolve(packageVersionDescriptors, mergedOptions).then(resolved => {
          for (const [name, result] of resolved) results.set(name, result);
        }),
      ]);
    } finally {
      const passed = [...results.values()].filter(r => r.status === 'passed').length;
      const failed = [...results.values()].filter(r => r.status === 'failed').length;

      this.bus?.complete({
        failed, passed, timedOut: 0, total: results.size,
      });

      await this.persistResults(new Map([...results].filter(([k]) => packageNames.includes(k))));
    }

    this.logger?.info(`Validation resolution complete for: ${packageNames.join(', ')}`);

    return results;
  }

  // ========================================================================
  // Private
  // ========================================================================

  /**
   * Log upstream dependency results (informational, not persisted).
   * These are packages the orchestrator installed as side-effects of resolving
   * dependencies — not packages the caller explicitly requested.
   */
  private logIncidental(incidental: Map<string, ValidationStateFailed | ValidationStatePassed>): void {
    if (incidental.size === 0) return;
    for (const [name, result] of incidental) {
      const detail = result.status === 'failed' ? `failed: ${result.error}` : 'passed';
      this.logger?.debug(`Upstream dependency '${name}' deploy result (informational): ${detail}`);
    }
  }

  /**
   * Write validation results to each package's `dist/package.json`.
   * Uses the provider to resolve package paths and ArtifactRepository
   * to patch the `sfpm.validation` field.
   */
  private async persistResults(results: Map<string, ValidationStateFailed | ValidationStatePassed>): Promise<void> {
    for (const [packageName, result] of results) {
      const definition = this.provider.getPackageDefinition(packageName);
      if (!definition?.path) continue;

      try {
        const repo = new ArtifactRepository(definition.path, this.logger, packageName);
        // eslint-disable-next-line no-await-in-loop
        await repo.updateValidation(result as unknown as Record<string, unknown>);
        this.logger?.debug(`Persisted validation result for '${packageName}'`);
      } catch (error) {
        this.logger?.warn(`Failed to persist validation for '${packageName}': ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
}

export {type ResolveOptions} from '../../types/validation.js';
