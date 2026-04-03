import * as core from '@actions/core';
import * as github from '@actions/github';
import {
  BuildOrchestrator,
  type CreateCompleteEvent,
  isStructuredLogger,
  LifecycleEngine,
  type Logger,
  type PackageType,
  ProjectService,
} from '@b64/sfpm-core';

import {BuildCacheService, type CachedBuildState, type PackageBuildState} from './build-cache.js';
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

export interface BuildResult {
  /** Artifacts base directory (relative to project root) */
  artifactsDir: string;
  /** Duration in milliseconds */
  duration: number;
  /** List of package names that failed */
  failedPackages: string[];
  /** Per-package build state (also cached for the resume step) */
  packages: PackageBuildState[];
  /** Whether state was cached for a resume step */
  stateCached: boolean;
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
 * 3. Collect build results, artifact paths, and creation request IDs
 * 4. Cache build state for the `build-resume` action
 * 5. Set outputs (artifact dir, per-package results)
 *
 * Unlocked packages are built with `asyncValidation: true` so that
 * the Salesforce platform starts validation in the background.
 * `PackageVersion.create()` returns immediately with a creation request ID
 * and 04t subscriber version ID. The `build-resume` action can then poll
 * for validation completion using `PackageVersion.getCreateStatus()`.
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
  const projectConfig = projectService.getProjectConfig();
  const projectGraph = projectService.getProjectGraph();
  const sfpmConfig = projectService.getSfpmConfig();

  const packageNames = options.packages?.length
    ? options.packages
    : projectConfig.getAllPackageNames();

  logger.info(`Packages to build: ${packageNames.join(', ')}`);

  // ------------------------------------------------------------------
  // 2. Create lifecycle engine and register hooks
  // ------------------------------------------------------------------
  const lifecycle = new LifecycleEngine({logger, stage: 'build'});
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }

  // ------------------------------------------------------------------
  // 3. Run BuildOrchestrator with async validation
  // ------------------------------------------------------------------
  if (isStructuredLogger(logger)) logger.group('Build');

  const orchestrator = new BuildOrchestrator(
    projectConfig,
    projectGraph,
    {
      buildNumber: options.buildNumber,
      devhubUsername: options.devhubUsername,
      force: options.force,
      ignoreFilesConfig: sfpmConfig.ignoreFiles,
      includeDependencies: options.includeDependencies,
      installationKey: options.installationKey,
      isAsyncValidation: true,
      npmScope: sfpmConfig.npmScope,
    },
    logger,
    projectDir,
    lifecycle,
  );

  // Collect creation request IDs from unlocked:create:complete events
  const createRequestIds = new Map<string, {packageVersionCreateRequestId: string; packageVersionId: string; version: string}>();
  orchestrator.on('unlocked:create:complete', (event: CreateCompleteEvent) => {
    if (event.packageVersionCreateRequestId) {
      createRequestIds.set(event.packageName, {
        packageVersionCreateRequestId: event.packageVersionCreateRequestId,
        packageVersionId: event.packageVersionId,
        version: event.versionNumber,
      });
    }
  });

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToBuildOrchestrator(orchestrator);

  const orchResult = await orchestrator.buildAll(packageNames);

  renderer.printSummary();
  if (isStructuredLogger(logger)) logger.groupEnd();

  // ------------------------------------------------------------------
  // 4. Build per-package state and determine which need validation
  // ------------------------------------------------------------------
  const artifactsDir = 'artifacts';
  const packageStates: PackageBuildState[] = orchResult.results.map(r => {
    const pkgDef = projectConfig.getPackageDefinition(r.packageName);
    const pkgType = pkgDef.type as string;
    const isUnlocked = pkgType === 'Unlocked';
    const createInfo = createRequestIds.get(r.packageName);
    const needsValidation = isUnlocked && r.success && !r.skipped && Boolean(createInfo);

    return {
      needsValidation,
      packageName: r.packageName,
      packageType: pkgType,
      packageVersionCreateRequestId: createInfo?.packageVersionCreateRequestId,
      packageVersionId: createInfo?.packageVersionId,
      skipped: r.skipped,
      success: r.success,
      version: createInfo?.version,
    };
  });

  // ------------------------------------------------------------------
  // 5. Cache build state for the resume step
  // ------------------------------------------------------------------
  let stateCached = false;
  const pendingValidation = packageStates.filter(p => p.needsValidation);

  if (pendingValidation.length > 0) {
    if (isStructuredLogger(logger)) logger.group('Cache Build State');

    const runId = String(github.context.runId);
    const buildCache = new BuildCacheService({logger, runId});

    const cacheState: CachedBuildState = {
      artifactsDir,
      cachedAt: Date.now(),
      devhubUsername: options.devhubUsername,
      packages: packageStates,
      projectDir,
      runId,
    };

    await buildCache.save(cacheState);
    buildCache.setOutputs(cacheState);
    stateCached = true;

    logger.info(`${pendingValidation.length} unlocked package(s) pending validation`);
    if (isStructuredLogger(logger)) logger.groupEnd();
  }

  // ------------------------------------------------------------------
  // 6. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const result: BuildResult = {
    artifactsDir,
    duration,
    failedPackages: orchResult.failedPackages,
    packages: packageStates,
    stateCached,
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

function setActionOutputs(result: BuildResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('artifacts-dir', result.artifactsDir);
  core.setOutput('duration', String(result.duration));
  core.setOutput('state-cached', String(result.stateCached));
  core.setOutput('failed-packages', result.failedPackages.join(','));
  core.setOutput('result', JSON.stringify(result));
}
