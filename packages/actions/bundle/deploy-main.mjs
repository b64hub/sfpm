import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  install
} from "./chunks/chunk-3LZSF6PB.mjs";
import "./chunks/chunk-WCWPZAWG.mjs";
import "./chunks/chunk-IVIWZITQ.mjs";
import {
  __toESM,
  require_core
} from "./chunks/chunk-YY7I435Q.mjs";

// src/deploy-main.ts
var core = __toESM(require_core(), 1);
try {
  const targetOrg = core.getInput("target-org", { required: true });
  const packagesInput = core.getInput("packages", { required: true });
  const packages = packagesInput.split(",").map((p) => p.trim()).filter(Boolean);
  const projectDir = core.getInput("project-dir") || void 0;
  const testLevel = core.getInput("test-level") || void 0;
  const force = core.getInput("force") === "true";
  const includeDependencies = core.getInput("include-dependencies") !== "false";
  const regressionTest = core.getInput("regression-test") === "true";
  const result = await install({
    force,
    includeDependencies,
    packages,
    projectDir,
    regressionTest,
    sourceOnly: true,
    targetOrg,
    testLevel
  });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
