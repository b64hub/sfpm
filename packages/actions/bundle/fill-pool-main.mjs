import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  DeploymentTask,
  SfpmPackageInstallTask,
  createPoolServices
} from "./chunks/chunk-47UVKOTC.mjs";
import {
  ActionsProgressRenderer
} from "./chunks/chunk-IVIWZITQ.mjs";
import {
  __toESM,
  createGitHubActionsLogger,
  loadSfpmConfig,
  require_core,
  require_lib2 as require_lib
} from "./chunks/chunk-YY7I435Q.mjs";

// src/fill-pool-main.ts
var core2 = __toESM(require_core(), 1);
var import_core2 = __toESM(require_lib(), 1);

// src/fill-pool.ts
var core = __toESM(require_core(), 1);
var import_core = __toESM(require_lib(), 1);
import path from "node:path";
async function fillPool(options) {
  const logger = createGitHubActionsLogger({ prefix: "fill-pool" });
  const startTime = Date.now();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const sfpmConfig = await loadSfpmConfig(projectDir, logger);
  const tags = Array.isArray(options.tag) ? options.tag : [options.tag];
  logger.info(`DevHub: ${options.devhubUsername}`);
  logger.info(`Max allocation: ${options.maxAllocation}`);
  logger.info("Connecting to hub org...");
  const devhub = await import_core.Org.create({ aliasOrUsername: options.devhubUsername });
  logger.info("Connected to hub org");
  const results = [];
  for (const tag of tags) {
    results.push(await fillOnePool({
      devhub,
      options,
      projectDir,
      sfpmConfig,
      tag
    }));
  }
  const report = {
    duration: Date.now() - startTime,
    results,
    success: results.every((r) => r.success)
  };
  setActionOutputs(report);
  for (const result of results) {
    if (result.success) {
      logger.info(`Pool "${result.tag}" provisioned ${result.succeeded} org(s) in ${Math.round(result.duration / 1e3)}s`);
    } else if (result.succeeded > 0) {
      core.warning(`Pool "${result.tag}" provisioning partially failed: ${result.succeeded} succeeded, ${result.failed} failed`);
    } else {
      core.error(`Pool "${result.tag}" provisioning failed: ${result.errors.join(", ")}`);
    }
  }
  if (!report.success) {
    core.setFailed(`Pool provisioning failed for: ${results.filter((r) => !r.success).map((r) => r.tag).join(", ")}`);
  }
  return report;
}
async function fillOnePool(context) {
  const { devhub, options, projectDir, sfpmConfig, tag } = context;
  const logger = createGitHubActionsLogger({ prefix: `fill-pool:${tag}` });
  const poolConfig = sfpmConfig.orgs?.[tag];
  const poolType = options.poolType ?? poolConfig?.type ?? import_core.OrgTypes.Scratch;
  logger.info(`Pool type: ${poolType}`);
  const config = buildPoolConfig({ ...options, tag }, poolType, projectDir, poolConfig);
  const tasks = buildTasks(config, devhub, projectDir, options.useLocalSource);
  const { manager } = createPoolServices({
    devhub,
    logger,
    poolType,
    tasks
  });
  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToManager(manager.bus);
  logger.info("Validating hub prerequisites...");
  await manager.validatePrerequisites();
  logger.info("Hub prerequisites validated");
  const provisionResult = await manager.provision(tag, config);
  renderer.printSummary();
  return {
    duration: provisionResult.elapsedMs,
    errors: provisionResult.errors,
    failed: provisionResult.failed,
    orgUsernames: provisionResult.succeeded.map((o) => o.auth.username).filter(Boolean),
    succeeded: provisionResult.succeeded.length,
    success: provisionResult.failed === 0,
    tag: provisionResult.tag
  };
}
function buildPoolConfig(options, poolType, projectDir, poolConfig) {
  const sizing = {
    batch: options.batchSize ?? poolConfig?.sizing?.batch,
    max: options.maxAllocation ?? poolConfig?.sizing?.max
  };
  const definitionFile = options.definitionFile ?? poolConfig?.definitionFile;
  if (!definitionFile) {
    throw new Error("definition-file is required (or configure definitionFile in pool/scratch/sandbox config)");
  }
  if (!sizing.max) {
    throw new Error("max-allocation is required (or configure sizing.max in pool config)");
  }
  if (poolType === import_core.OrgTypes.Sandbox) {
    return {
      ...poolConfig,
      definitionFile: path.resolve(projectDir, definitionFile),
      namePattern: options.sandboxNamePattern ?? poolConfig?.namePattern ?? "SB",
      sizing,
      type: import_core.OrgTypes.Sandbox
    };
  }
  return {
    ...poolConfig,
    definitionFile: path.resolve(projectDir, definitionFile),
    expiryDays: options.expiryDays ?? poolConfig?.expiryDays,
    sizing,
    type: import_core.OrgTypes.Scratch
  };
}
function setActionOutputs(report) {
  const succeeded = report.results.reduce((sum, r) => sum + r.succeeded, 0);
  const failed = report.results.reduce((sum, r) => sum + r.failed, 0);
  core.setOutput("success", String(report.success));
  core.setOutput("tag", report.results.map((r) => r.tag).join(","));
  core.setOutput("succeeded", String(succeeded));
  core.setOutput("failed", String(failed));
  core.setOutput("duration", String(report.duration));
  core.setOutput("result", JSON.stringify(report));
  core.setOutput("org-usernames", report.results.flatMap((r) => r.orgUsernames).join(","));
}
function buildTasks(config, devhub, projectDir, useLocalSource) {
  const tasks = [];
  if (config.type === import_core.OrgTypes.Scratch) {
    tasks.push(new SfpmPackageInstallTask({ devhub }));
  }
  tasks.push(new DeploymentTask({
    continueOnError: config.deployment?.continueOnError ?? true,
    testLevel: config.deployment?.testLevel,
    useLocalSource,
    workingDirectory: projectDir
  }));
  return tasks;
}

// src/fill-pool-main.ts
try {
  const devhubUsername = core2.getInput("devhub-username", { required: true });
  const tag = core2.getInput("pool-tag", { required: true }).split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  const maxAllocation = core2.getInput("max-allocation") ? Number.parseInt(core2.getInput("max-allocation"), 10) : void 0;
  const poolTypeInput = core2.getInput("pool-type") || void 0;
  const poolType = poolTypeInput === "sandbox" ? import_core2.OrgTypes.Sandbox : poolTypeInput === "scratch" ? import_core2.OrgTypes.Scratch : void 0;
  const batchSize = core2.getInput("batch-size") ? Number.parseInt(core2.getInput("batch-size"), 10) : void 0;
  const definitionFile = core2.getInput("definition-file") || void 0;
  const expiryDays = core2.getInput("expiry-days") ? Number.parseInt(core2.getInput("expiry-days"), 10) : void 0;
  const projectDir = core2.getInput("project-dir") || void 0;
  const sandboxNamePattern = core2.getInput("sandbox-name-pattern") || void 0;
  const useLocalSource = core2.getInput("use-local-source") === "true";
  const result = await fillPool({
    batchSize,
    definitionFile,
    devhubUsername,
    expiryDays,
    maxAllocation,
    poolType,
    projectDir,
    sandboxNamePattern,
    tag,
    useLocalSource
  });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error2) {
  const message = error2 instanceof Error ? error2.message : String(error2);
  core2.setFailed(message);
  process.exitCode = 1;
}
