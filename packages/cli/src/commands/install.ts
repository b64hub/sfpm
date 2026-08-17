import {
  ArtifactProvider, InstallOrchestrator, LifecycleEngine, parseInstallationKeys, ProjectService, type TestLevel,
} from '@b64hub/sfpm-core'
import {createTracer} from '@b64hub/sfpm-telemetry'
import {Args, Flags} from '@oclif/core'
import {Org} from '@salesforce/core'
import {execSync} from 'node:child_process'
import EventEmitter from 'node:events'
// Register SFDMU data installer (side-effect import triggers decorator registration)
import '@b64hub/sfpm-sfdmu'

import SfpmCommand from '../sfpm-command.js'
import {attachInstallBridge} from '../ui/install-event-bridge.js'
import {InstallProgressRenderer} from '../ui/install-progress-renderer.js'
import {renderApp} from '../ui/run.js'
import {resolveCliProjectDir} from '../utils/project-dir.js'

export default class Install extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to install',
      required: true,
    }),
  }
  static override description = 'install packages'
  /**
   * Lifecycle stage: **install**
   *
   * Operations executed per package:
   * - `install:pre`  — before each package installation starts
   * - `install:post` — after each package installation succeeds
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --plain',
    '<%= config.bin %> <%= command.id %> my-package -o my-sandbox --json',
    '<%= config.bin %> <%= command.id %> package-a package-b -o my-sandbox',
  ]
  static override flags = {
    force: Flags.boolean({char: 'f', description: 'force reinstall even if already installed'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key for unlocked packages; repeat as <package>=<key>, or a bare value as the default', multiple: true}),
    'no-dependencies': Flags.boolean({description: 'only install the specified packages, skip transitive dependencies'}),
    'regression-test': Flags.boolean({description: 'run tests in direct dependents after install to detect regressions'}),
    'target-org': Flags.string({
      char: 'o', description: 'target org username', env: 'SF_TARGET_ORG', required: true,
    }),
    'test-level': Flags.string({
      char: 'l', description: 'deployment test level (for source deployments)', options: ['NoTestRun', 'RunSpecifiedTests', 'RunLocalTests', 'RunAllTestsInOrg'],
    }),
    turbo: Flags.boolean({description: 'single-package mode for external orchestrators (implies --no-dependencies --force)'}),
  }
  static override strict = false

  public async execute(): Promise<any> {
    const {args, argv, flags} = await this.parse(Install)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]

    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // --turbo: single-package mode for external orchestrators (Turbo, CI matrix)
    if (flags.turbo) {
      if (packages.length !== 1) {
        this.error('--turbo requires exactly one package name', {exit: 1})
      }

      flags['no-dependencies'] = true
      flags.force = true
    }

    const projectDir = resolveCliProjectDir();

    // Fetch specified packages (and transitive deps) from registry into node_modules.
    // Uses npm (not pnpm) to bypass workspace symlink resolution.
    const pkgArgs = packages.map(p => `'${p}'`).join(' ');
    this.log(`Fetching artifacts: ${packages.join(', ')}`);
    execSync(`npm install --no-save ${pkgArgs}`, {cwd: projectDir, stdio: 'inherit'});

    // Create ArtifactProvider: starts from named packages, discovers
    // transitive sfpm dependencies by walking node_modules.
    const artifactProvider = new ArtifactProvider({logger: this.sfpmLogger, packages, projectDir});
    const projectService = await ProjectService.create(projectDir, artifactProvider);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();

    // All resolved packages come from the provider (explicit + transitive sfpm deps)
    const resolvedPackages = projectConfig.getAllPackageNames();

    const mode = this.outputMode;

    const sfpmConfig = projectService.getSfpmConfig();

    // Create lifecycle engine and register hooks from config
    const lifecycle = LifecycleEngine.stage('install');
    for (const hooks of sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    const installOptions = {
      testLevel: flags['test-level'] as TestLevel,
      unlocked: flags['installation-key']?.length ? {installationKeys: parseInstallationKeys(flags['installation-key'])} : undefined,
    }

    const targetOrg = await Org.create({aliasOrUsername: flags['target-org']})

    const isInk = mode === 'interactive';
    const uiBus = isInk ? new EventEmitter() : undefined;
    const {logger: pinoLogger, logPath} = this.createRunLogger(uiBus);

    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg,
      projectConfig,
      projectGraph,
      {
        ...installOptions, force: flags.force, includeDependencies: !flags['no-dependencies'], regressionTest: flags['regression-test'],
      },
      pinoLogger,
    )

    let renderer: InstallProgressRenderer | undefined;
    let inkInstance: ReturnType<typeof renderApp> | undefined;

    if (isInk) {
      attachInstallBridge(orchestrator.installBus, orchestrator.orchestrationBus, uiBus!);
      inkInstance = renderApp(uiBus!, {logPath});
    } else {
      renderer = new InstallProgressRenderer({
        logger: {
          error: (msgOrError: Error | string) => this.error(msgOrError),
          log: (msg: string) => this.log(msg),
        },
        mode,
        targetOrg: flags['target-org'],
      });
      renderer.attachTo(orchestrator.installBus, orchestrator.orchestrationBus);
    }

    const tracer = createTracer({serviceName: 'sfpm-cli'})
    tracer.subscribe({install: orchestrator.installBus, orchestration: orchestrator.orchestrationBus})

    try {
      const result = await orchestrator.installAll(resolvedPackages)

      await tracer.shutdown()

      // Let the app self-exit after rendering its terminal state — on success
      // AND on failure. this.error() below throws (and eventually exits the
      // process), so it must run after ink has rendered, not before: doing
      // this check first would race React's async render and freeze the
      // screen mid-step.
      if (inkInstance) {
        await inkInstance.waitUntilExit();
        inkInstance = undefined;
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ')
        this.error(`Install failed for: ${failedNames}`, {exit: 2})
      }

      return result
    } catch (error) {
      renderer?.handleError(error as Error)

      if (error instanceof Error) {
        this.error(error.message, {exit: 2})
      }

      throw error
    } finally {
      inkInstance?.unmount()
    }
  }
}
