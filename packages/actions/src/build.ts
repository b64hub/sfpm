import * as core from '@actions/core';
import {
  BuildOrchestrator,
  LifecycleEngine,
  type PendingValidationDescriptor,
  ProjectService,
} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';

import {createGitHubActionsLogger} from './logger.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface BuildOptions {
  /** Build number to use for package versions */
  buildNumber?: string;
  /** DevHub username or alias (required for unlocked packages) */
  devhubUsername?: string;
  /** Force build even when no source changes detected */
  force?: boolean;
  /** Also build transitive dependencies of requested packages */
  includeDependencies?: boolean;
  /** Installation key for unlocked packages */
  installationKey?: string;
  /** Packages to build (empty = all) */
  packages?: string[];
  /** Project directory (default: workspace root) */
  projectDir?: string;
}

/**
 * Per-package build outcome. Fed straight into the `result` action output —
 * the `build-validation` action reads that output (via `needs.build.outputs.result`
 * in the workflow) as its `build-result` input, no cache or polling involved.
 */
export interface PackageBuildState {
  /** Package name */
  packageName: string;
  /** Package type (Unlocked, Source, Data) */
  packageType: string;
  /**
   * Descriptor for in-flight async validation, present only for unlocked
   * packages that successfully queued a package version creation request.
   * Resolved by `build-validation` via {@link ValidationResolver}.
   */
  pendingValidation?: PendingValidationDescriptor;
  /** Whether the build was skipped (no source changes) */
  skipped: boolean;
  /** Whether this package built successfully */
  success: boolean;
}

export interface BuildResult {
  /** Duration in milliseconds */
  duration: number;
  /** List of package names that failed */
  failedPackages: string[];
  /** Per-package build outcome, including any pending async validation */
  packages: PackageBuildState[];
  /** Whether all packages built successfully */
  success: boolean;
}

// ============================================================================
// Build Pipeline
// ============================================================================

/**
 * Main entry point for the build GitHub Action.
 *
 * Workflow:
 * 1. Initialise project and resolve packages
 * 2. Run BuildOrchestrator with async validation for unlocked packages
 * 3. Collect per-package build outcomes, including any pending validation descriptor
 * 4. Set outputs (per-package results, including pending validation descriptors
 *    the `build-validation` action reads via its `build-result` input)
 *
 * Lifecycle stage: **build**
 *
 * Operations executed per package:
 * - `build:pre`  — before each package build starts
 * - `build:post` — after each package build succeeds
 *
 * Unlocked packages are built with `asyncValidation: true` so that
 * the Salesforce platform starts validation in the background.
 * `PackageVersion.create()` returns immediately with a creation request ID,
 * captured as a {@link PendingValidationDescriptor} on the package's result.
 * The `build-validation` action resolves these via `ValidationResolver`.
 *
 * @example
 * ```typescript
 * const result = await build({
 *   devhubUsername: 'devhub@myorg.com',
 *   packages: ['my-unlocked-pkg', 'my-source-pkg'],
 * });
 * ```
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
  const logger = createGitHubActionsLogger({prefix: 'build'});
  const startTime = Date.now();

  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();

  logger.info(`Project directory: ${projectDir}`);
  if (options.devhubUsername) logger.info(`DevHub: ${options.devhubUsername}`);

  // ------------------------------------------------------------------
  // 1. Initialise project
  // ------------------------------------------------------------------
  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();
  const projectGraph = projectService.getProjectGraph();
  const sfpmConfig = projectService.getSfpmConfig();

  const packageNames = options.packages?.length
    ? options.packages
    : projectConfig.getAllPackageNames();

  logger.info(`Packages to build: ${packageNames.join(', ')}`);

  // ------------------------------------------------------------------
  // 2. Create lifecycle engine and register hooks
  // ------------------------------------------------------------------
  const lifecycle = LifecycleEngine.stage('build');
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }

  // ------------------------------------------------------------------
  // 3. Run BuildOrchestrator (default mode with full validation)
  // ------------------------------------------------------------------
  const orchestrator = new BuildOrchestrator(
    projectConfig,
    projectGraph,
    {},
    {
      buildNumber: options.buildNumber,
      force: options.force,
      includeDependencies: options.includeDependencies,
      unlocked: options.installationKey ? {installationKey: options.installationKey} : undefined,
      validation: 'full',
    },
    logger,
  );

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToBuildOrchestrator(orchestrator.buildBus, orchestrator.orchestrationBus);

  const tracer = createTracer({serviceName: 'sfpm-actions'});
  tracer.subscribe({build: orchestrator.buildBus, orchestration: orchestrator.orchestrationBus});

  const orchResult = await orchestrator.buildAll(packageNames);

  renderer.printSummary();
  await tracer.shutdown();

  // ------------------------------------------------------------------
  // 4. Build per-package state from orchestrator results
  // ------------------------------------------------------------------
  // `r.result` is the PendingValidationDescriptor an unlocked package
  // returns when it queues async validation — present only on success,
  // absent for build-skips and non-unlocked packages.
  const packageStates: PackageBuildState[] = orchResult.results.map(r => {
    const pkgDef = projectConfig.getPackageDefinition(r.packageName);

    return {
      packageName: r.packageName,
      packageType: (pkgDef?.type ?? '') as string,
      pendingValidation: r.result,
      skipped: r.skipped,
      success: r.success,
    };
  });

  // ------------------------------------------------------------------
  // 5. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const result: BuildResult = {
    duration,
    failedPackages: orchResult.failedPackages,
    packages: packageStates,
    success: orchResult.success,
  };

  setActionOutputs(result);

  if (orchResult.success) {
    logger.info(`Build completed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = orchResult.failedPackages.join(', ');
    core.setFailed(`Build failed for: ${failed}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

export function setActionOutputs(result: BuildResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('duration', String(result.duration));
  core.setOutput('failed-packages', result.failedPackages.join(','));
  core.setOutput('result', JSON.stringify(result));
}
