import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  build
} from "./chunks/chunk-3FCRPYZR.mjs";
import "./chunks/chunk-RR5Z7IRJ.mjs";
import "./chunks/chunk-SZNJWE6U.mjs";
import "./chunks/chunk-TSBBYIFI.mjs";
import {
  parseInstallationKeys,
  require_core
} from "./chunks/chunk-HMYN73EY.mjs";
import {
  __toESM
} from "./chunks/chunk-4ZHSI3J6.mjs";

// src/build-main.ts
var core = __toESM(require_core(), 1);
try {
  const devhubUsername = core.getInput("devhub-username") || void 0;
  const projectDir = core.getInput("project-dir") || void 0;
  const buildNumber = core.getInput("build-number") || void 0;
  const installationKeysInput = core.getInput("installation-keys") || "";
  const installationKeys = installationKeysInput ? parseInstallationKeys(installationKeysInput.split("\n").map((l) => l.trim()).filter(Boolean)) : void 0;
  for (const key of Object.values(installationKeys ?? {})) core.setSecret(key);
  const packagesInput = core.getInput("packages") || "";
  const packages = packagesInput ? packagesInput.split(",").map((p) => p.trim()).filter(Boolean) : void 0;
  const force = core.getInput("force") === "true";
  const includeDependencies = core.getInput("include-dependencies") !== "false";
  const validation = core.getInput("validation") || void 0;
  const result = await build({
    buildNumber,
    devhubUsername,
    force,
    includeDependencies,
    installationKeys,
    packages,
    projectDir,
    validation
  });
  if (!result.success) {
    process.exitCode = 1;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  core.setFailed(message);
  process.exitCode = 1;
}
