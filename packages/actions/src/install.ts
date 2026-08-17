import * as core from '@actions/core';
import {
  ArtifactProvider,
  InstallOrchestrator,
  LifecycleEngine,
  type ProjectDefinitionProvider,
  ProjectGraph,
  ProjectService,
  type SfpmConfig,
  type TestLevel,
  WorkspaceProvider,
} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {Org} from '@salesforce/core';
import {execFileSync} from 'node:child_process';

import {createGitHubActionsLogger} from './logger.js';
import {ActionsProgressRenderer} from './progress-renderer.js';

// ============================================================================
// Types
// ============================================================================

export interface InstallOptions {
  /** Force reinstall even if already installed with matching version/hash */
  force?: boolean;
  /** Install transitive dependencies of requested packages (default: true) */
  includeDependencies?: boolean;
  /** Package name -> installation key overrides for unlocked packages. `'*'` is the default for any package without an explicit entry. */
  installationKeys?: Record<string, string>;
  /**
   * Where to resolve packages from:
   * - `'registry'` (default) — fetch published packages from the npm
   *   registry via `npm install --no-save`.
   * - `'local'` — resolve directly from each package's `<packageDir>/dist/`
   *   output already present on disk (e.g. restored via download-artifact
   *   from an earlier `build` job in the same workflow run). No registry
   *   involved — installs exactly what this run built.
   */
  origin?: 'local' | 'registry';
  /** Packages to install */
  packages: string[];
  /** Project directory (default: workspace root) */
  projectDir?: string;
  /** Run tests in direct dependents of installed packages after install completes */
  regressionTest?: boolean;
  /** Deploy unlocked packages as source instead of installing a package version */
  sourceOnly?: boolean;
  /** Target org username or alias */
  targetOrg: string;
  /** Deployment test level (for source deployments) */
  testLevel?: TestLevel;
}

export interface InstallResult {
  /** Duration in milliseconds */
  duration: number;
  /** List of package names that failed */
  failedPackages: string[];
  /** Per-package install results */
  packages: Array<{
    duration: number;
    error?: string;
    packageName: string;
    skipped: boolean;
    success: boolean;
  }>;
  /** Whether all packages installed successfully */
  success: boolean;
}

// ============================================================================
// Install Pipeline
// ============================================================================

/**
 * Main entry point for the install GitHub Action.
 *
 * Workflow:
 * 1. Resolve project definition — from the npm registry (default) or
 *    directly from local `<packageDir>/dist/` output already on disk
 * 2. Run InstallOrchestrator against the target org
 * 3. Set outputs (success, per-package results)
 *
 * Lifecycle stage: **install**
 *
 * Operations executed per package:
 * - `install:pre`  — before each package install starts
 * - `install:post` — after each package install succeeds
 *
 * @example
 * ```typescript
 * const result = await install({
 *   packages: ['my-package'],
 *   targetOrg: 'my-sandbox',
 * });
 * ```
 */
export async function install(options: InstallOptions): Promise<InstallResult> {
  const logger = createGitHubActionsLogger({prefix: 'install'});
  const startTime = Date.now();

  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const origin = options.origin ?? 'registry';

  logger.info(`Project directory: ${projectDir}`);
  logger.info(`Target org: ${options.targetOrg}`);
  logger.info(`Packages to install: ${options.packages.join(', ')}`);
  logger.info(`Origin: ${origin}`);

  // ------------------------------------------------------------------
  // 1. Resolve project definition
  // ------------------------------------------------------------------
  let projectConfig: ProjectDefinitionProvider;
  let projectGraph: ProjectGraph;
  let sfpmConfig: SfpmConfig;
  let resolvedPackages: string[];

  if (origin === 'registry') {
    // Fetch published artifacts into node_modules
    execFileSync('npm', ['install', '--no-save', ...options.packages], {cwd: projectDir, stdio: 'inherit'});

    const artifactProvider = new ArtifactProvider({logger, packages: options.packages, projectDir});
    const projectService = await ProjectService.create(projectDir, artifactProvider);
    projectConfig = projectService.getDefinitionProvider();
    projectGraph = projectService.getProjectGraph();
    sfpmConfig = projectService.getSfpmConfig();
    // ArtifactProvider walks node_modules to discover transitive sfpm deps,
    // so getAllPackageNames() already reflects the full resolved set.
    resolvedPackages = projectConfig.getAllPackageNames();
  } else {
    // Resolve directly from local dist/ output already on disk — no registry.
    // `distAware: true` overlays packageVersionId/sourceHash from each
    // package's dist/package.json, so unlocked packages install the exact
    // version this run built rather than deploying source-only.
    const workspaceProvider = new WorkspaceProvider({distAware: true, logger, projectDir});
    const projectService = await ProjectService.create(projectDir, workspaceProvider);
    projectConfig = projectService.getDefinitionProvider();
    projectGraph = projectService.getProjectGraph();
    sfpmConfig = projectService.getSfpmConfig();
    resolvedPackages = options.packages;
  }

  // ------------------------------------------------------------------
  // 2. Create lifecycle engine and register hooks
  // ------------------------------------------------------------------
  const lifecycle = LifecycleEngine.stage('install');
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }

  // ------------------------------------------------------------------
  // 3. Run InstallOrchestrator
  // ------------------------------------------------------------------
  const targetOrg = await Org.create({aliasOrUsername: options.targetOrg});

  const unlocked = (options.installationKeys || options.sourceOnly)
    ? {installationKeys: options.installationKeys, sourceOnly: options.sourceOnly}
    : undefined;

  const orchestrator = InstallOrchestrator.forArtifact(
    targetOrg,
    projectConfig,
    projectGraph,
    {
      force: options.force,
      includeDependencies: options.includeDependencies,
      regressionTest: options.regressionTest,
      testLevel: options.testLevel,
      unlocked,
    },
    logger,
  );

  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToInstaller(orchestrator.installBus, orchestrator.orchestrationBus);

  const tracer = createTracer({serviceName: 'sfpm-actions'});
  tracer.subscribe({install: orchestrator.installBus, orchestration: orchestrator.orchestrationBus});

  const orchResult = await orchestrator.installAll(resolvedPackages);

  renderer.printSummary();
  await tracer.shutdown();

  // ------------------------------------------------------------------
  // 4. Set outputs and return result
  // ------------------------------------------------------------------
  const duration = Date.now() - startTime;
  const result: InstallResult = {
    duration,
    failedPackages: orchResult.failedPackages,
    packages: orchResult.results.map(r => ({
      duration: r.duration,
      error: r.error,
      packageName: r.packageName,
      skipped: r.skipped,
      success: r.success,
    })),
    success: orchResult.success,
  };

  setActionOutputs(result);

  if (orchResult.success) {
    logger.info(`Install completed in ${Math.round(duration / 1000)}s`);
  } else {
    const failed = orchResult.failedPackages.join(', ');
    core.setFailed(`Install failed for: ${failed}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

function setActionOutputs(result: InstallResult): void {
  core.setOutput('success', String(result.success));
  core.setOutput('duration', String(result.duration));
  core.setOutput('failed-packages', result.failedPackages.join(','));
  core.setOutput('result', JSON.stringify(result));
}
