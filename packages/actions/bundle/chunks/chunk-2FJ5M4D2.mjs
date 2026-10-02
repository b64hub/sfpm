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
  BuildOrchestrator,
  LifecycleEngine,
  ProjectService,
  __toESM,
  createGitHubActionsLogger,
  require_core
} from "./chunk-YY7I435Q.mjs";

// src/build.ts
var core = __toESM(require_core(), 1);
async function build(options) {
  const logger = createGitHubActionsLogger({ prefix: "build" });
  const startTime = Date.now();
  const projectDir = options.projectDir ?? process.env.GITHUB_WORKSPACE ?? process.cwd();
  logger.info(`Project directory: ${projectDir}`);
  if (options.devhubUsername) logger.info(`DevHub: ${options.devhubUsername}`);
  const projectService = await ProjectService.getInstance(projectDir);
  const projectConfig = projectService.getDefinitionProvider();
  const projectGraph = projectService.getProjectGraph();
  const sfpmConfig = projectService.getSfpmConfig();
  const packageNames = options.packages?.length ? options.packages : projectConfig.getAllPackageNames();
  logger.info(`Packages to build: ${packageNames.join(", ")}`);
  const lifecycle = LifecycleEngine.stage("build");
  for (const hooks of sfpmConfig.hooks ?? []) {
    lifecycle.use(hooks);
  }
  const orchestrator = BuildOrchestrator.create(
    projectConfig,
    {},
    projectGraph,
    {
      buildNumber: options.buildNumber,
      force: options.force,
      includeDependencies: options.includeDependencies,
      unlocked: options.installationKeys ? { installationKeys: options.installationKeys } : void 0,
      validation: options.validation
    },
    logger
  );
  const renderer = new ActionsProgressRenderer(logger);
  renderer.attachToBuildOrchestrator(orchestrator.buildBus, orchestrator.orchestrationBus);
  const tracer = createTracer({ serviceName: "sfpm-actions" });
  tracer.subscribe({ build: orchestrator.buildBus, orchestration: orchestrator.orchestrationBus });
  const orchResult = await orchestrator.buildAll(packageNames);
  renderer.printSummary();
  await tracer.shutdown();
  const packageStates = orchResult.results.map((r) => {
    const pkgDef = projectConfig.getPackageDefinition(r.packageName);
    return {
      packageName: r.packageName,
      packageType: pkgDef?.type ?? "",
      pendingValidation: r.result?.pendingValidation,
      skipped: r.skipped,
      success: r.success
    };
  });
  const duration = Date.now() - startTime;
  const result = {
    duration,
    failedPackages: orchResult.failedPackages,
    packages: packageStates,
    success: orchResult.success
  };
  setActionOutputs(result);
  if (orchResult.success) {
    logger.info(`Build completed in ${Math.round(duration / 1e3)}s`);
  } else {
    const failed = orchResult.failedPackages.join(", ");
    core.setFailed(`Build failed for: ${failed}`);
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
  build,
  setActionOutputs
};
