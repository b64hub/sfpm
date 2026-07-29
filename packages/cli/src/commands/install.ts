import {
  ArtifactProvider, InstallOrchestrator, LifecycleEngine, ProjectService, type TestLevel,
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

export default class Install extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to install',
      required: true,
    }),
  }
  static override description = 'install one or more packages'
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
    'installation-key': Flags.string({char: 'k', description: 'installation key for unlocked packages'}),
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

    // Use SFPM_PROJECT_DIR env var if set (for debugging from different directory), otherwise use cwd
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();

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
      deployment: flags['test-level'] ? {testLevel: flags['test-level'] as TestLevel} : undefined,
      force: flags.force,
      targetOrg: flags['target-org'],
      versionInstall: flags['installation-key'] ? {installationKeys: {'*': flags['installation-key']}} : undefined,
    }

    const targetOrg = await Org.create({aliasOrUsername: flags['target-org']})

    const orchestrator = InstallOrchestrator.forArtifact(
      targetOrg,
      projectConfig,
      projectGraph,
      {...installOptions, includeDependencies: !flags['no-dependencies'], regressionTest: flags['regression-test']},
      this.sfpmLogger,
    )

    const isInk = mode === 'interactive';
    let renderer: InstallProgressRenderer | undefined;
    let inkInstance: ReturnType<typeof renderApp> | undefined;

    if (isInk) {
      const uiBus = new EventEmitter();
      attachInstallBridge(orchestrator.installBus, orchestrator.orchestrationBus, uiBus);
      inkInstance = renderApp(uiBus);
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
