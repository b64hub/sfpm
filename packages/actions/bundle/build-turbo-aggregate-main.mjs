import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  setActionOutputs
} from "./chunks/chunk-2FJ5M4D2.mjs";
import "./chunks/chunk-WCWPZAWG.mjs";
import "./chunks/chunk-IVIWZITQ.mjs";
import {
  DIST_DIR,
  ProjectService,
  __toESM,
  createGitHubActionsLogger,
  require_core
} from "./chunks/chunk-YY7I435Q.mjs";

// src/build-turbo-aggregate-main.ts
var core2 = __toESM(require_core(), 1);

// src/build-turbo-aggregate.ts
var core = __toESM(require_core(), 1);
import fs from "node:fs";
import path from "node:path";
async function buildTurboAggregate(options) {
  const logger = createGitHubActionsLogger({ prefix: "build-turbo-aggregate" });
  const startTime = Date.now();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const taskName = options.taskName ?? "sfpm:build";
  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();
  const packageNames = options.packages?.length ? options.packages : projectConfig.getAllPackageNames();
  const hitTaskIds = readTurboCacheHits(projectDir, taskName);
  const packages = [];
  const failedPackages = [];
  for (const packageName of packageNames) {
    const packageDir = projectConfig.getPackageDir(packageName);
    const packageType = projectConfig.getPackageDefinition(packageName)?.type ?? "";
    if (!packageDir) {
      logger.error(`Could not resolve workspace directory for '${packageName}'`);
      failedPackages.push(packageName);
      packages.push({
        packageName,
        packageType,
        skipped: false,
        success: false
      });
      continue;
    }
    const resultPath = path.join(packageDir, DIST_DIR, "build-result.json");
    if (!fs.existsSync(resultPath)) {
      logger.error(`No build result found for '${packageName}' at ${resultPath}`);
      failedPackages.push(packageName);
      packages.push({
        packageName,
        packageType,
        skipped: false,
        success: false
      });
      continue;
    }
    const { result: orchestration } = JSON.parse(fs.readFileSync(resultPath, "utf8"));
    if (!orchestration) {
      logger.error(`Build result at ${resultPath} has no result payload \u2014 the build likely failed before producing output`);
      failedPackages.push(packageName);
      packages.push({
        packageName,
        packageType,
        skipped: false,
        success: false
      });
      continue;
    }
    const packageResult = orchestration.results.find((r) => r.packageName === packageName);
    if (!packageResult) {
      logger.error(`Build result at ${resultPath} has no entry for '${packageName}'`);
      failedPackages.push(packageName);
      packages.push({
        packageName,
        packageType,
        skipped: false,
        success: false
      });
      continue;
    }
    const npmPackageJsonPath = path.join(packageDir, "package.json");
    const npmName = fs.existsSync(npmPackageJsonPath) ? JSON.parse(fs.readFileSync(npmPackageJsonPath, "utf8")).name : packageName;
    const isCacheHit = hitTaskIds.has(`${npmName}#${taskName}`);
    if (!isCacheHit && !packageResult.success) {
      logger.error(`Build failed for '${packageName}': ${packageResult.error ?? "unknown error"}`);
    }
    const state = isCacheHit ? {
      packageName,
      packageType,
      skipped: true,
      success: true
    } : {
      packageName,
      packageType,
      pendingValidation: packageResult.result?.pendingValidation,
      skipped: packageResult.skipped,
      success: packageResult.success
    };
    packages.push(state);
    if (!state.success) failedPackages.push(packageName);
  }
  const result = {
    duration: Date.now() - startTime,
    failedPackages,
    packages,
    success: failedPackages.length === 0
  };
  setActionOutputs(result);
  if (result.success) {
    logger.info(`Aggregated ${packages.length} package(s) in ${Math.round(result.duration / 1e3)}s`);
  } else {
    core.setFailed(`Build failed for: ${failedPackages.join(", ")}`);
  }
  return result;
}
function readTurboCacheHits(projectDir, taskName) {
  const runsDir = path.join(projectDir, ".turbo", "runs");
  if (!fs.existsSync(runsDir)) {
    throw new Error(`No turbo run summary found at ${runsDir}. Run 'turbo run ${taskName} --summarize' before this action \u2014 without it there is no reliable way to tell a fresh build from a replayed cache hit.`);
  }
  const files = fs.readdirSync(runsDir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) {
    throw new Error(`No turbo run summary files found in ${runsDir}. Run 'turbo run ${taskName} --summarize' before this action.`);
  }
  const latest = files.map((file) => ({ file, mtimeMs: fs.statSync(path.join(runsDir, file)).mtimeMs })).sort((a, b) => b.mtimeMs - a.mtimeMs)[0].file;
  const summary = JSON.parse(fs.readFileSync(path.join(runsDir, latest), "utf8"));
  return new Set(summary.tasks.filter((t) => t.taskId.endsWith(`#${taskName}`) && t.cache.status === "HIT").map((t) => t.taskId));
}

// src/build-turbo-aggregate-main.ts
try {
  const projectDir = core2.getInput("project-dir") || void 0;
  const taskName = core2.getInput("task-name") || void 0;
  const packagesInput = core2.getInput("packages") || "";
  const packages = packagesInput ? packagesInput.split(",").map((p) => p.trim()).filter(Boolean) : void 0;
  const result = await buildTurboAggregate({ packages, projectDir, taskName });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core2.setFailed(message);
  process.exitCode = 1;
}
