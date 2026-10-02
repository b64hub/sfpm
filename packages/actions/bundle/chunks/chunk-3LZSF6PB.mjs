import {createRequire as ___createRequire} from 'node:module';
import {fileURLToPath as ___fileURLToPath} from 'node:url';
import {dirname as ___dirname_fn} from 'node:path';
const require = ___createRequire(import.meta.url);
const __filename = ___fileURLToPath(import.meta.url);
const __dirname = ___dirname_fn(__filename);
process.env.SF_DISABLE_LOG_FILE ??= 'true';
import {
  createTracer
} from "./chunk-WCWPZAWG.mjs";
import {
  ActionsProgressRenderer
} from "./chunk-IVIWZITQ.mjs";
import {
  ArtifactProvider,
  InstallOrchestrator,
  LifecycleEngine,
  ProjectService,
  WorkspaceProvider,
  __toESM,
  createGitHubActionsLogger,
  require_core,
  require_lib2 as require_lib
} from "./chunk-YY7I435Q.mjs";

// src/install.ts
var core = __toESM(require_core(), 1);
var import_core = __toESM(require_lib(), 1);
import { execFileSync } from "node:child_process";
async function install(options) {
  const logger = createGitHubActionsLogger({ prefix: "install" });
  const startTime = Date.now();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  const origin = options.origin ?? "registry";
  logger.info(`Project directory: ${projectDir}`);
  logger.info(`Target org: ${options.targetOrg}`);
  logger.info(`Packages to install: ${options.packages.join(", ")}`);
  logger.info(`Origin: ${origin}`);
  let projectConfig;
  let projectGraph;
  let sfpmConfig;
  let resolvedPackages;
  if (origin === "registry") {
    execFileSync("npm", ["install", "--no-save", "--ignore-scripts", ...options.packages], { cwd: projectDir, stdio: "inherit" });
    const artifactProvider = new ArtifactProvider({ logger, packages: options.packages, projectDir });
    const projectService = await ProjectService.create(projectDir, artifactProvider);
    projectConfig = projectService.getDefinitionProvider();
    projectGraph = projectService.getProjectGraph();
    sfpmConfig = projectService.getSfpmConfig();
    resolvedPackages = projectConfig.getAllPackageNames();
  } else {
    const workspaceProvider = new WorkspaceProvider({ distAware: true, logger, projectDir });
    const projectService = await ProjectService.create(projectDir, workspaceProvider);
    projectConfig = projectService.getDefinitionProvider();
    projectGraph = projectService.getProjectGraph();
    sfpmConfig = projectService.getSfpmConfig();
    resolvedPackages = options.packages;
  }
  const lifecycle = LifecycleEngine.stage("install");
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }
  const targetOrg = await import_core.Org.create({ aliasOrUsername: options.targetOrg });
  const unlocked = options.installationKeys || options.sourceOnly ? { installationKeys: options.installationKeys, sourceOnly: options.sourceOnly } : void 0;
  const orchestrator = InstallOrchestrator.forArtifact(
    targetOrg,
    projectConfig,
    projectGraph,
    {
      force: options.force,
      includeDependencies: options.includeDependencies,
      regressionTest: options.regressionTest,
      testLevel: options.testLevel,
      unlocked
    },
    logger
  );
  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToInstaller(orchestrator.installBus, orchestrator.orchestrationBus);
  const tracer = createTracer({ serviceName: "sfpm-actions" });
  tracer.subscribe({ install: orchestrator.installBus, orchestration: orchestrator.orchestrationBus });
  const orchResult = await orchestrator.installAll(resolvedPackages);
  renderer.printSummary();
  await tracer.shutdown();
  const duration = Date.now() - startTime;
  const result = {
    duration,
    failedPackages: orchResult.failedPackages,
    packages: orchResult.results.map((r) => ({
      duration: r.duration,
      error: r.error,
      packageName: r.packageName,
      skipped: r.skipped,
      success: r.success
    })),
    success: orchResult.success
  };
  setActionOutputs(result);
  if (orchResult.success) {
    logger.info(`Install completed in ${Math.round(duration / 1e3)}s`);
  } else {
    const failed = orchResult.failedPackages.join(", ");
    core.setFailed(`Install failed for: ${failed}`);
  }
  return result;
}
function setActionOutputs(result) {
  core.setOutput("success", String(result.success));
  core.setOutput("duration", String(result.duration));
  core.setOutput("failed-packages", result.failedPackages.join(","));
  core.setOutput("result", JSON.stringify(result));
}

export {
  install
};
