import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  ProjectService,
  ValidationEventBus,
  ValidationResolver,
  __toESM,
  createGitHubActionsLogger,
  require_core
} from "./chunks/chunk-YY7I435Q.mjs";

// src/build-validation-main.ts
var core2 = __toESM(require_core(), 1);

// src/build-validation.ts
var core = __toESM(require_core(), 1);
async function buildValidation(options) {
  const logger = createGitHubActionsLogger({ prefix: "build-validation" });
  const startTime = Date.now();
  let state;
  try {
    state = JSON.parse(options.buildResult);
  } catch {
    core.setFailed("Invalid build-result input \u2014 expected the JSON `result` output from the build action");
    return {
      duration: 0,
      packages: [],
      publishablePackages: [],
      success: false
    };
  }
  const pendingAll = state.packages.filter((p) => Boolean(p.pendingValidation));
  const pending = options.packages?.length ? pendingAll.filter((p) => options.packages.includes(p.packageName)) : pendingAll;
  let resolved = /* @__PURE__ */ new Map();
  if (pending.length > 0) {
    logger.info(`Resolving validation for ${pending.length} package(s): ${pending.map((p) => p.packageName).join(", ")}`);
    const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();
    logger.group("Validation Resolution");
    const resolver = new ValidationResolver(projectConfig, projectGraph, logger, new ValidationEventBus());
    resolved = await resolver.resolve(
      pending.map((p) => p.pendingValidation),
      {
        maxWaitMs: (options.maxWaitMinutes ?? 120) * 60 * 1e3,
        pollingIntervalMs: (options.pollingIntervalSeconds ?? 30) * 1e3
      }
    );
    logger.groupEnd();
  } else {
    logger.info("No pending validations to resolve");
  }
  const packages = [];
  for (const pkg of state.packages) {
    if (!pkg.pendingValidation) {
      packages.push({ packageName: pkg.packageName, status: "Skipped" });
      continue;
    }
    const validationState = resolved.get(pkg.packageName);
    if (!validationState) continue;
    packages.push(validationState.status === "passed" ? { codeCoverage: validationState.testCoverage, packageName: pkg.packageName, status: "Success" } : { error: validationState.error, packageName: pkg.packageName, status: "Error" });
  }
  const publishablePackages = state.packages.filter((pkg) => {
    if (!pkg.success || pkg.skipped) return false;
    if (!pkg.pendingValidation) return true;
    return resolved.get(pkg.packageName)?.status === "passed";
  }).map((pkg) => pkg.packageName);
  const duration = Date.now() - startTime;
  const allPassed = packages.filter((p) => p.status !== "Skipped").every((p) => p.status === "Success");
  const result = {
    duration,
    packages,
    publishablePackages,
    success: allPassed
  };
  setActionOutputs(result);
  if (allPassed) {
    logger.info(`All validations passed in ${Math.round(duration / 1e3)}s`);
  } else {
    const failed = packages.filter((p) => p.status === "Error");
    core.setFailed(`Validation failed for: ${failed.map((f) => f.packageName).join(", ")}`);
  }
  return result;
}
function setActionOutputs(result) {
  core.setOutput("success", String(result.success));
  core.setOutput("duration", String(result.duration));
  core.setOutput("result", JSON.stringify(result));
  core.setOutput("publishable-packages", result.publishablePackages.join(","));
  const validated = result.packages.filter((p) => p.status === "Success");
  const failed = result.packages.filter((p) => p.status === "Error");
  core.setOutput("validated-count", String(validated.length));
  core.setOutput("failed-count", String(failed.length));
  core.setOutput("failed-packages", failed.map((f) => f.packageName).join(","));
}

// src/build-validation-main.ts
try {
  const buildResult = core2.getInput("build-result", { required: true });
  const projectDir = core2.getInput("project-dir") || void 0;
  const packagesInput = core2.getInput("packages") || "";
  const packages = packagesInput ? packagesInput.split(",").map((p) => p.trim()).filter(Boolean) : void 0;
  const maxWaitMinutes = core2.getInput("max-wait-minutes") ? Number.parseInt(core2.getInput("max-wait-minutes"), 10) : void 0;
  const pollingIntervalSeconds = core2.getInput("polling-interval-seconds") ? Number.parseInt(core2.getInput("polling-interval-seconds"), 10) : void 0;
  const result = await buildValidation({
    buildResult,
    maxWaitMinutes,
    packages,
    pollingIntervalSeconds,
    projectDir
  });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core2.setFailed(message);
  process.exitCode = 1;
}
