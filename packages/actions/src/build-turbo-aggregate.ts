import * as core from '@actions/core';
import {
  DIST_DIR,
  type OrchestrationResult,
  type PackageBuildResult,
  ProjectService,
} from '@b64hub/sfpm-core';
import fs from 'node:fs';
import path from 'node:path';

import type {BuildResult, PackageBuildState} from './build.js';

import {setActionOutputs} from './build.js';
import {createGitHubActionsLogger} from './logger.js';

// ============================================================================
// Types
// ============================================================================

export interface BuildTurboAggregateOptions {
  /** Restrict aggregation to this subset of package names (default: all packages in the project) */
  packages?: string[];
  /** Project directory — where `turbo run` was invoked and `.turbo/runs/` lives (default: workspace root) */
  projectDir?: string;
  /** Name of the turbo task each package built as (default: 'sfpm:build') */
  taskName?: string;
}

// ============================================================================
// Build Turbo Aggregate
// ============================================================================

/**
 * Turn per-package turbo build output into the same `BuildResult` JSON shape
 * the `build` action produces, so `build-validation` doesn't care which one
 * ran.
 *
 * Expects each package's own `sfpm:build` script (e.g.
 * `sfpm build <pkg> --turbo --json > dist/build-result.json`) to have already
 * written its result — that file only reflects a real build when turbo
 * actually ran the task. On a turbo cache *hit* the file is replayed
 * verbatim from whatever run originally produced it, so its
 * `pendingValidation` may point at an already-resolved (or long-expired)
 * package version request. Turbo's own `--summarize` run report is the only
 * reliable signal for "did this really run" — this reads that report and
 * forces `skipped: true` / drops `pendingValidation` for every cache hit,
 * regardless of what the replayed file claims.
 */
export async function buildTurboAggregate(options: BuildTurboAggregateOptions): Promise<BuildResult> {
  const logger = createGitHubActionsLogger({prefix: 'build-turbo-aggregate'});
  const startTime = Date.now();

  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const taskName = options.taskName ?? 'sfpm:build';

  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();

  const packageNames = options.packages?.length ? options.packages : projectConfig.getAllPackageNames();
  const hitTaskIds = readTurboCacheHits(projectDir, taskName);

  const packages: PackageBuildState[] = [];
  const failedPackages: string[] = [];

  for (const packageName of packageNames) {
    const packageDir = projectConfig.getPackageDir(packageName);
    const packageType = (projectConfig.getPackageDefinition(packageName)?.type ?? '') as string;

    if (!packageDir) {
      logger.error(`Could not resolve workspace directory for '${packageName}'`);
      failedPackages.push(packageName);
      packages.push({
        packageName, packageType, skipped: false, success: false,
      });
      continue;
    }

    const resultPath = path.join(projectDir, packageDir, DIST_DIR, 'build-result.json');
    if (!fs.existsSync(resultPath)) {
      logger.error(`No build result found for '${packageName}' at ${resultPath}`);
      failedPackages.push(packageName);
      packages.push({
        packageName, packageType, skipped: false, success: false,
      });
      continue;
    }

    const orchestration = JSON.parse(fs.readFileSync(resultPath, 'utf8')) as OrchestrationResult<PackageBuildResult>;
    const packageResult = orchestration.results.find(r => r.packageName === packageName);
    if (!packageResult) {
      logger.error(`Build result at ${resultPath} has no entry for '${packageName}'`);
      failedPackages.push(packageName);
      packages.push({
        packageName, packageType, skipped: false, success: false,
      });
      continue;
    }

    const npmPackageJsonPath = path.join(projectDir, packageDir, 'package.json');
    const npmName = fs.existsSync(npmPackageJsonPath)
      ? (JSON.parse(fs.readFileSync(npmPackageJsonPath, 'utf8')).name as string)
      : packageName;

    const isCacheHit = hitTaskIds.has(`${npmName}#${taskName}`);

    if (!isCacheHit && !packageResult.success) {
      logger.error(`Build failed for '${packageName}': ${packageResult.error ?? 'unknown error'}`);
    }

    const state: PackageBuildState = isCacheHit
      ? {
        packageName, packageType, skipped: true, success: true,
      }
      : {
        packageName,
        packageType,
        pendingValidation: packageResult.result?.pendingValidation,
        skipped: packageResult.skipped,
        success: packageResult.success,
      };

    packages.push(state);
    if (!state.success) failedPackages.push(packageName);
  }

  const result: BuildResult = {
    duration: Date.now() - startTime,
    failedPackages,
    packages,
    success: failedPackages.length === 0,
  };

  setActionOutputs(result);

  if (result.success) {
    logger.info(`Aggregated ${packages.length} package(s) in ${Math.round(result.duration / 1000)}s`);
  } else {
    core.setFailed(`Build failed for: ${failedPackages.join(', ')}`);
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Read turbo's `--summarize` run report and return the set of task IDs
 * (`<npmPackageName>#<taskName>`) that were served from cache — i.e. did
 * NOT actually execute this run.
 */
function readTurboCacheHits(projectDir: string, taskName: string): Set<string> {
  const runsDir = path.join(projectDir, '.turbo', 'runs');
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No turbo run summary found at ${runsDir}. Run 'turbo run ${taskName} --summarize' before this action — `
      + 'without it there is no reliable way to tell a fresh build from a replayed cache hit.');
  }

  const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    throw new Error(`No turbo run summary files found in ${runsDir}. Run 'turbo run ${taskName} --summarize' before this action.`);
  }

  // Multiple summaries can accumulate under .turbo/runs/ — the most recently
  // written one is the run this action is aggregating.
  const latest = files
  .map(file => ({file, mtimeMs: fs.statSync(path.join(runsDir, file)).mtimeMs}))
  .sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file;

  const summary = JSON.parse(fs.readFileSync(path.join(runsDir, latest), 'utf8')) as {
    tasks: Array<{cache: {status: string}; taskId: string}>;
  };

  return new Set(summary.tasks
  .filter(t => t.taskId.endsWith(`#${taskName}`) && t.cache.status === 'HIT')
  .map(t => t.taskId));
}
