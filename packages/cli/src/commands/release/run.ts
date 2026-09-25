import {
  ArtifactProvider, InstallOrchestrator, LifecycleEngine, ProjectService, readReleaseDefinition, type TestLevel,
} from '@b64hub/sfpm-core';
import {createTracer} from '@b64hub/sfpm-telemetry';
import {Args, Flags} from '@oclif/core';
import {Org} from '@salesforce/core';
import EventEmitter from 'node:events';
import path from 'node:path';

import SfpmCommand from '../../sfpm-command.js';
import {reconcileManifest} from '../../types/release.js';
import {attachInstallBridge} from '../../ui/adapters/install-event-bridge.js';
import {renderApp} from '../../ui/renderers/run-orchestrator.js';
import {resolveCliProjectDir} from '../../utils/project-dir.js';

export default class ReleaseRun extends SfpmCommand {
  static override args = {
    file: Args.string({
      description: 'Path to the release YAML file',
      required: true,
    }),
  }
  static override description = 'Run a release by installing packages from a release definition'
  static override examples = [
    '<%= config.bin %> <%= command.id %> release/summer-2025.yaml -o my-sandbox',
    '<%= config.bin %> <%= command.id %> release/summer-2025.yaml -o my-sandbox --json',
  ]
  static override flags = {
    'skip-version-check': Flags.boolean({
      description: 'Skip version mismatch checks (still validates packages are present)',
    }),
    'target-org': Flags.string({
      char: 'o',
      description: 'Target org username',
      env: 'SF_TARGET_ORG',
      required: true,
    }),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any,complexity
  public async execute(): Promise<any> {
    const {args, flags} = await this.parse(ReleaseRun);

    const projectDir = resolveCliProjectDir();

    // Step 1 & 2: Read and parse release definition
    let definition;
    try {
      definition = readReleaseDefinition(path.resolve(args.file));
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 3: Extract package names
    const names = definition!.packages.map(p => p.name);

    // Step 4: Create ArtifactProvider
    const artifactProvider = new ArtifactProvider({logger: this.sfpmLogger, packages: names, projectDir});

    // Step 5: Create ProjectService and resolve graph
    let projectService;
    try {
      projectService = await ProjectService.create(projectDir, artifactProvider);
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    const projectConfig = projectService!.getDefinitionProvider();
    const projectGraph = projectService!.getProjectGraph();

    // Step 6: TRUST BOUNDARY GATE — reconcile manifest vs node_modules
    const resolvedVersions = new Map(projectConfig.getAllPackageDefinitions().map(p => [p.name, p.version]));

    const {mismatched, missing} = reconcileManifest(
      definition!.packages,
      resolvedVersions,
      {skipVersionCheck: flags['skip-version-check']},
    );

    if (missing.length > 0) {
      const msg = [
        `Release "${definition!.release}" declares packages not present in node_modules: ${missing.join(', ')}.`,
        "Run 'npm ci' (or 'npm install --no-save <name>@<version>') before 'release run'.",
      ].join(' ');
      this.error(msg);
    }

    if (mismatched.length > 0) {
      const msg = [
        `Version mismatch for: ${mismatched.map(m => `${m.name} (expected ${m.expected}, found ${m.actual})`).join('; ')}.`,
        'Re-install the declared versions or pass --skip-version-check.',
      ].join(' ');
      this.error(msg);
    }

    // Step 7: Resolve all packages (includes transitive sfpm deps)
    const resolvedPackages = projectConfig.getAllPackageNames();

    // Step 8: Load sfpm config and lifecycle hooks
    const sfpmConfig = projectService!.getSfpmConfig();
    const lifecycle = LifecycleEngine.stage('install');
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    // Step 9: Create target org
    let targetOrg;
    try {
      targetOrg = await Org.create({aliasOrUsername: flags['target-org']});
    } catch (error) {
      this.error(error instanceof Error ? error.message : String(error));
    }

    // Step 10: Setup logging and UI
    const mode = this.outputMode;
    const isInk = mode !== 'json';

    const uiBus = isInk ? new EventEmitter() : undefined;
    const {logger: pinoLogger, logPath} = this.createRunLogger(uiBus);

    // Step 11: Create orchestrator with manifest options
    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg!,
      projectConfig,
      projectGraph,
      {
        force: definition!.options?.force,
        includeDependencies: definition!.options?.includeDependencies ?? true,
        regressionTest: definition!.options?.regressionTest,
        testLevel: definition!.options?.testLevel as TestLevel,
        unlocked: definition!.options?.unlocked,
      },
      pinoLogger,
    );

    // Step 12: Setup ink UI bridge if needed
    let inkInstance: ReturnType<typeof renderApp> | undefined;
    if (isInk) {
      attachInstallBridge(orchestrator.installBus, orchestrator.orchestrationBus, uiBus!);
      inkInstance = renderApp(uiBus!, {logPath, mode: mode === 'interactive' ? 'interactive' : 'plain'});
    }

    // Setup telemetry tracer
    const tracer = createTracer({serviceName: 'sfpm-cli'});
    tracer.subscribe({install: orchestrator.installBus, orchestration: orchestrator.orchestrationBus});

    try {
      // Run installation
      const result = await orchestrator.installAll(resolvedPackages);

      await tracer.shutdown();

      // Let the app self-exit after rendering its terminal state
      if (inkInstance) {
        await inkInstance.waitUntilExit();
        inkInstance = undefined;
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ');
        this.error(`Install failed for: ${failedNames}`, {exit: 2});
      }

      return {release: definition!.release, ...result};
    } catch (error) {
      if (error instanceof Error) {
        this.error(error.message, {exit: 2});
      }

      throw error;
    } finally {
      inkInstance?.unmount();
    }
  }
}
