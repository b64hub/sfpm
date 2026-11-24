import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  PoolStage,
  createPoolServices
} from "./chunks/chunk-G3LCQFQG.mjs";
import {
  createGitHubActionsLogger,
  require_core,
  require_lib2 as require_lib
} from "./chunks/chunk-HIDGGZTH.mjs";
import {
  __toESM
} from "./chunks/chunk-4ZHSI3J6.mjs";

// src/clean-pool-main.ts
var core2 = __toESM(require_core(), 1);
var import_core2 = __toESM(require_lib(), 1);

// src/clean-pool.ts
var core = __toESM(require_core(), 1);
var import_core = __toESM(require_lib(), 1);
async function cleanPool(options) {
  const logger = createGitHubActionsLogger({ prefix: "clean-pool" });
  const startTime = Date.now();
  const poolType = options.poolType ?? import_core.OrgTypes.Scratch;
  const tags = Array.isArray(options.tag) ? options.tag : [options.tag];
  logger.info(`Pool type: ${poolType}`);
  logger.info(`DevHub: ${options.devhubUsername}`);
  logger.info("Connecting to hub org...");
  const devhub = await import_core.Org.create({ aliasOrUsername: options.devhubUsername });
  const results = [];
  for (const tag of tags) {
    const tagLogger = createGitHubActionsLogger({ prefix: `clean-pool:${tag}` });
    const { manager } = createPoolServices({ devhub, logger: tagLogger, poolType });
    const deleteResult = await manager.delete(tag, {
      excludeStages: options.excludeStages,
      myPool: options.myPool
    });
    results.push({
      deleted: deleteResult.deleted.length,
      duration: deleteResult.elapsedMs,
      errors: deleteResult.errors,
      orgUsernames: deleteResult.deleted.map((org) => org.auth.username).filter(Boolean),
      success: deleteResult.errors.length === 0,
      tag: deleteResult.tag
    });
  }
  const report = {
    deleted: results.reduce((sum, r) => sum + r.deleted, 0),
    duration: Date.now() - startTime,
    results,
    success: results.every((r) => r.success)
  };
  setActionOutputs(report);
  for (const result of results) {
    if (result.success) {
      logger.info(`Pool "${result.tag}" cleaned: deleted ${result.deleted} org(s) in ${Math.round(result.duration / 1e3)}s`);
    } else if (result.deleted > 0) {
      core.warning(`Pool "${result.tag}" cleanup partially failed: ${result.deleted} deleted, ${result.errors.length} error(s)`);
    } else {
      core.error(`Pool "${result.tag}" cleanup failed: ${result.errors.join(", ")}`);
    }
  }
  if (!report.success) {
    core.setFailed(`Pool cleanup failed for: ${results.filter((r) => !r.success).map((r) => r.tag).join(", ")}`);
  }
  return report;
}
function setActionOutputs(report) {
  core.setOutput("success", String(report.success));
  core.setOutput("tag", report.results.map((r) => r.tag).join(","));
  core.setOutput("deleted", String(report.deleted));
  core.setOutput("duration", String(report.duration));
  core.setOutput("org-usernames", report.results.flatMap((r) => r.orgUsernames).join(","));
  core.setOutput("result", JSON.stringify(report));
}

// src/clean-pool-main.ts
try {
  const devhubUsername = core2.getInput("devhub-username", { required: true });
  const tag = core2.getInput("pool-tag", { required: true }).split(/[\n,]/).map((t) => t.trim()).filter(Boolean);
  const poolTypeInput = core2.getInput("pool-type") || void 0;
  const poolType = poolTypeInput === "sandbox" ? import_core2.OrgTypes.Sandbox : poolTypeInput === "scratch" ? import_core2.OrgTypes.Scratch : void 0;
  const excludeStagesInput = core2.getInput("exclude-stages").split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const validStages = new Set(Object.values(PoolStage));
  for (const stage of excludeStagesInput) {
    if (!validStages.has(stage)) {
      throw new Error(`Invalid exclude-stages value "${stage}" \u2014 expected one of: ${[...validStages].join(", ")}`);
    }
  }
  const excludeStages = excludeStagesInput;
  const myPool = core2.getInput("my-pool") === "true";
  const result = await cleanPool({
    devhubUsername,
    excludeStages,
    myPool,
    poolType,
    tag
  });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error2) {
  const message = error2 instanceof Error ? error2.message : String(error2);
  core2.setFailed(message);
  process.exitCode = 1;
}
