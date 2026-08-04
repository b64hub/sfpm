import {
  BuildOrchestrator,
  type BuildOrchestratorOptions, type BuildOrg,
  type BuildWatcherPayload,
  LifecycleEngine,
  noopLogger,
  type OrchestrationResult,
  PackageType,
  type PendingValidationDescriptor, ProjectService, ValidationEventBus, ValidationResolver,
  type WatcherState,
} from '@b64hub/sfpm-core'
import {ScratchOrgProvider} from '@b64hub/sfpm-orgs'
import {createTracer} from '@b64hub/sfpm-telemetry'
import {NimbusLocalValidator, NimbusValidationEventBus} from '@b64hub/sfpm-validation'
import {
  Args, Flags,
} from '@oclif/core'
import {ConfigAggregator, Org} from '@salesforce/core'
// Register SFDMU data builder (side-effect import triggers decorator registration)
import '@b64hub/sfpm-sfdmu'
import chalk from 'chalk'
import EventEmitter from 'node:events'
import path from 'node:path'
import ora from 'ora'

import SfpmCommand from '../../sfpm-command.js'
import {attachBuildBridge} from '../../ui/build-event-bridge.js'
import {BuildProgressRenderer, OutputMode} from '../../ui/build-progress-renderer.js'
import {renderApp} from '../../ui/run.js'
import {ValidationProgressRenderer} from '../../ui/validation-progress-renderer.js'
import {resolvePackageInputs} from '../../utils/package-resolver.js'
import {forkWatcher, validationRunnerScript} from '../../utils/watcher.js'

interface ResolvedBuildFlags {
  async: boolean;
  autoCreatedBuildOrg?: {devhub: Org; username: string};
  buildOptions: BuildOrchestratorOptions;
  buildOrgUsername?: string;
  devhubUsername?: string;
  mode: OutputMode;
  noDependencies: boolean;
  packages: string[];
  projectDir: string;
  resolvedPackages: string[];
  sfpmConfig: any;
  waitMinutes: number;
}

export default class Build extends SfpmCommand {
  static override args = {
    packages: Args.string({
      description: 'package(s) to build',
      required: true,
    }),
  }
  static override description = 'build packages'
  /**
   * Lifecycle stage: **build**
   *
   * Operations executed per package:
   * - `build:pre`  — before each package build starts
   * - `build:post` — after each package build succeeds
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --plain',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --json',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --force',
    '<%= config.bin %> <%= command.id %> package-a package-b -v my-devhub',
  ]
  static override flags = {
    async: Flags.boolean({description: 'return immediately without waiting for validation results'}),
    'build-number': Flags.string({char: 'b', description: 'build number'}),
    'build-org': Flags.string({char: 'o', description: 'target org for source package validation (deploy + test)'}),
    force: Flags.boolean({char: 'f', description: 'build even if no source changes detected', env: 'SFPM_FORCE_BUILD'}),
    'installation-key': Flags.string({char: 'k', description: 'installation key'}),
    'no-dependencies': Flags.boolean({default: false, description: 'build the specified packages without their transitive dependencies'}),
    'source-only': Flags.boolean({description: 'route all packages through source deployment (no DevHub, no package version IDs)', env: 'SFPM_SOURCE_ONLY'}),
    tag: Flags.string({char: 't', description: 'tag for the build'}),
    'target-dev-hub': Flags.string({
      char: 'v',
      async defaultHelp() {
        try {
          const configAggregator = await ConfigAggregator.create();
          return configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
        } catch {

        }
      },
      description: 'target dev hub username',
      env: 'SF_DEV_HUB',
    }),
    turbo: Flags.boolean({description: 'single-package mode for external orchestrators (implies --no-dependencies)'}),
    validation: Flags.string({
      allowNo: true,
      char: 'l',
      default: 'local',
      description: 'validation level (use --no-validation to skip)',
      options: ['local', 'org', 'full'],
    }),
    wait: Flags.integer({
      char: 'w', default: 120, description: 'timeout in minutes for package version creation', min: 1,
    }),
  }
  static override strict = false

  public async execute(): Promise<void> {
    const resolved = await this.resolveFlags()

    // Auto-create a scratch org for source validation if needed
    await this.ensureBuildOrg(resolved)

    // Create lifecycle engine and register hooks from config
    const lifecycle = LifecycleEngine.stage('build');
    for (const hooks of resolved.sfpmConfig.hooks ?? []) {
      lifecycle.use(hooks);
    }

    try {
      await this.buildOrchestrated(resolved)
    } finally {
      // Clean up auto-created scratch org (skip if --async defers to watcher)
      if (resolved.autoCreatedBuildOrg && !resolved.async) {
        await this.cleanupBuildOrg(resolved)
      }
    }
  }

  private async buildOrchestrated(resolved: ResolvedBuildFlags): Promise<void> {
    const projectService = await ProjectService.getInstance(resolved.projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const projectGraph = projectService.getProjectGraph();

    // Resolve BuildOrg from resolved options
    const buildOrg: BuildOrg = {}
    if (resolved.devhubUsername) {
      buildOrg.devhub = await Org.create({aliasOrUsername: resolved.devhubUsername})
    }

    if (resolved.buildOrgUsername) {
      buildOrg.buildOrg = await Org.create({aliasOrUsername: resolved.buildOrgUsername})
    }

    const isInk = resolved.mode === 'interactive';
    const uiBus = isInk ? new EventEmitter() : undefined;
    const {logger: pinoLogger, logPath} = this.createRunLogger(uiBus);

    // Build local validator for compile + dependency checks (all modes except 'none').
    // Created here so it shares the run logger.
    let localValidator: NimbusLocalValidator | undefined;
    if (resolved.buildOptions.validation !== 'none') {
      const manifests = projectConfig.getAllPackageDefinitions().map(def => ({
        declaredDependencies: new Set(projectConfig.getDependencies(def.name).map(d => d.name)),
        packageId: def.name,
        packagePath: path.join(projectConfig.projectDir, def.path),
      }));
      localValidator = new NimbusLocalValidator(
        {
          config: {
            daemon: {autoStart: false, autoStop: true, enabled: false},
          },
          eventBus: new NimbusValidationEventBus(),
          logger: pinoLogger,
        },
        manifests,
      );
    }

    const orchestrator = new BuildOrchestrator(
      projectConfig,
      projectGraph,
      buildOrg,
      {...resolved.buildOptions, includeDependencies: !resolved.noDependencies},
      pinoLogger,
      localValidator,
    )

    // For the ink path, create the ValidationEventBus here so the bridge can
    // wire validation events before buildAll starts. The bus is passed to the
    // resolver later if there are pending validations.
    const validationBus = isInk ? new ValidationEventBus() : undefined;

    let renderer: BuildProgressRenderer | undefined;
    let inkInstance: ReturnType<typeof renderApp> | undefined;

    if (uiBus) {
      attachBuildBridge(orchestrator.buildBus, orchestrator.orchestrationBus, uiBus, validationBus);
      inkInstance = renderApp(uiBus, {logPath});
    } else {
      renderer = new BuildProgressRenderer({
        logger: {
          error: (msgOrError: Error | string) => this.error(msgOrError),
          log: (msg: string) => this.log(msg),
        },
        mode: resolved.mode,
      });
      renderer.attachTo(orchestrator.buildBus, orchestrator.orchestrationBus)
    }

    const tracer = createTracer({serviceName: 'sfpm-cli'})
    tracer.subscribe({build: orchestrator.buildBus, orchestration: orchestrator.orchestrationBus})

    try {
      const result = await orchestrator.buildAll(resolved.resolvedPackages)
      await tracer.shutdown()

      if (resolved.mode === 'json') {
        this.logJson(result)
      }

      if (!result.success) {
        // Let the app self-exit after rendering its failed terminal state.
        // this.error() below throws (and eventually exits the process), so it
        // must run after ink has rendered, not before: doing this check first
        // would race React's async render and freeze the screen mid-step.
        if (inkInstance) {
          await inkInstance.waitUntilExit();
          inkInstance = undefined;
        }

        const failedNames = result.failedPackages.join(', ')
        this.error(`Build failed for: ${failedNames}`, {exit: 1})
      }

      const pendingValidations = result.results
      .map(r => r.result)
      .filter((r): r is PendingValidationDescriptor => r !== null && r !== undefined)

      if (isInk && validationBus && !resolved.async) {
        // Ink path: validation runs while ink is still mounted.
        // The bridge already wired validationBus → uiBus; just drive the resolver.
        if (pendingValidations.length > 0) {
          await this.resolveValidationsInline(pendingValidations, resolved, validationBus)
          // Validation is async enough that React has rendered all events by now.
          inkInstance?.unmount();
        } else {
          // No validation: let the app self-exit after rendering its terminal state.
          // Calling unmount() immediately would race React's async render and drop
          // the final package:complete update from the screen.
          await inkInstance?.waitUntilExit();
        }

        inkInstance = undefined;
      } else {
        // Non-ink path or async: unmount before handing off to the existing handler.
        inkInstance?.unmount();
        inkInstance = undefined;
        await this.handleValidationResults(pendingValidations, resolved)
      }
    } catch (error) {
      renderer?.handleError(error as Error)
      throw error
    } finally {
      inkInstance?.unmount();
    }
  }

  /**
   * Delete an auto-created scratch org after the build completes.
   */
  private async cleanupBuildOrg(resolved: ResolvedBuildFlags): Promise<void> {
    if (!resolved.autoCreatedBuildOrg) return

    const {devhub: hubOrg, username} = resolved.autoCreatedBuildOrg
    const spinner = resolved.mode === 'interactive'
      ? ora(`Deleting build org ${chalk.cyan(username)}...`).start()
      : undefined

    try {
      const scratchOrg = await Org.create({aliasOrUsername: username})
      await scratchOrg.deleteFrom(hubOrg)
      spinner?.succeed(`Build org ${chalk.cyan(username)} deleted`)
    } catch (error) {
      spinner?.fail(`Failed to delete build org ${chalk.cyan(username)}`)
      this.sfpmLogger?.warn(`Failed to delete auto-created build org ${username}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Auto-create a scratch org for source package validation when no --build-org is provided.
   *
   * Only creates an org when:
   * - No explicit --build-org flag
   * - Validation is not skipped
   * - At least one resolved package is a Source package
   */
  private async ensureBuildOrg(resolved: ResolvedBuildFlags): Promise<void> {
    if (resolved.buildOrgUsername || resolved.buildOptions.validation === 'none' || resolved.buildOptions.validation === 'local') return

    // Check if any resolved package is a Source package
    const projectService = await ProjectService.getInstance(resolved.projectDir)
    const projectConfig = projectService.getDefinitionProvider()
    const hasSourcePackage = resolved.resolvedPackages.some(pkg => {
      try {
        return projectConfig.getPackageType(pkg) === PackageType.Source
      } catch {
        return false
      }
    })

    if (!hasSourcePackage) return

    if (!resolved.devhubUsername) {
      this.error('A target dev hub is required to auto-create a build org for source validation. Specify one with --target-dev-hub (-v).', {exit: 1})
    }

    const spinner = resolved.mode === 'interactive'
      ? ora('Creating scratch org for source validation...').start()
      : undefined

    const hubOrg = await Org.create({aliasOrUsername: resolved.devhubUsername})
    const provider = new ScratchOrgProvider(hubOrg)

    const scratchDefPath = path.join(resolved.projectDir, 'config', 'project-scratch-def.json')
    const alias = `sfpm-build-${Date.now()}`

    try {
      const scratchOrg = await provider.createOrg({
        alias,
        definitionfile: scratchDefPath,
        durationDays: 1,
        noancestors: true,
        nonamespace: true,
      })

      const {username} = scratchOrg.auth
      if (!username) {
        spinner?.fail('Failed to create scratch org: no username returned')
        this.error('Failed to create scratch org: no username returned', {exit: 1})
      }

      spinner?.succeed(`Build org created: ${chalk.cyan(username)}`)

      resolved.buildOrgUsername = username
      resolved.autoCreatedBuildOrg = {devhub: hubOrg, username}
    } catch (error) {
      spinner?.fail('Failed to create scratch org')
      throw error
    }
  }

  /**
   * Handle pending validations: resolve inline or fork a background watcher.
   *
   * - No `--async`: resolve all validations inline with ValidationResolver.
   * - `--async`: fork watcher process for background resolution.
   */
  private async handleValidationResults(
    pendingValidations: PendingValidationDescriptor[],
    resolved: ResolvedBuildFlags,
  ): Promise<void> {
    if (pendingValidations.length === 0) return

    if (resolved.async) {
      await this.handleValidationResultsAsync(pendingValidations, resolved);
      return;
    }

    await this.resolveValidationsInline(pendingValidations, resolved);
  }

  private async handleValidationResultsAsync(pendingValidations: PendingValidationDescriptor[], resolved: ResolvedBuildFlags): Promise<void> {
    this.log(chalk.yellow('\nValidation results will be available asynchronously.'));

    const payload: BuildWatcherPayload = {
      ...(resolved.autoCreatedBuildOrg && {
        cleanupBuildOrg: {
          devhubUsername: resolved.devhubUsername ?? '',
          username: resolved.autoCreatedBuildOrg.username,
        },
      }),
      validations: pendingValidations,
    };

    const state: WatcherState = {
      auth: {username: resolved.devhubUsername ?? ''},
      createdAt: Date.now(),
      jobType: 'build',
      payload,
      projectDir: resolved.projectDir,
      timeoutMs: resolved.waitMinutes * 60 * 1000,
      updatedAt: Date.now(),
      watcherStatus: 'starting',
    };

    const {id, pid} = await forkWatcher(state, validationRunnerScript());
    const pkgNames = pendingValidations.map(pv => pv.packageName).join(', ');

    if (resolved.mode === 'json') {
      this.logJson({
        packages: pkgNames,
        stateId: id,
        watcherPid: pid,
      });
    } else {
      this.log(chalk.yellow(`\nValidation watcher started ${chalk.dim(`(PID ${pid})`)} for: ${chalk.bold(pkgNames)}`));
      this.log(chalk.dim('Run \'sfpm watch status\' to check progress.'));
    }
  }

  /**
   * Parse and validate flags, resolve project context, compose BuildOptions.
   */
  private async resolveFlags(): Promise<ResolvedBuildFlags> {
    const {args, argv, flags} = await this.parse(Build)

    const packages = argv.length > 0 ? argv as string[] : [args.packages]
    if (!packages || packages.length === 0) {
      this.error('At least one package name is required')
    }

    // --turbo: single-package mode for external orchestrators
    if (flags.turbo) {
      if (packages.length !== 1) {
        this.error('--turbo requires exactly one package name', {exit: 1})
      }

      flags['no-dependencies'] = true
    }

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const projectService = await ProjectService.getInstance(projectDir);
    const projectConfig = projectService.getDefinitionProvider();
    const sfpmConfig = projectService.getSfpmConfig();

    // Resolve user input to canonical scoped package names
    const resolvedPackages = await resolvePackageInputs(packages, projectConfig, {json: this.outputMode === 'json'})

    // Resolve validation level: --no-validation → 'none', --validation=X → X, default → 'local'
    const validation = (flags.validation === 'false' ? 'none' : flags.validation ?? 'local') as 'full' | 'local' | 'none' | 'org';

    // Resolve devhub (not required when validation doesn't need an org)
    const needsOrg = validation === 'org' || validation === 'full';
    const needsDevHub = needsOrg && !flags['source-only'];
    let devhubUsername = flags['target-dev-hub']
    if (!devhubUsername && needsDevHub) {
      const configAggregator = await ConfigAggregator.create()
      devhubUsername = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined
    }

    if (!devhubUsername && needsDevHub) {
      this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1})
    }

    const mode = this.outputMode;

    const buildOptions: BuildOrchestratorOptions = {
      buildNumber: flags['build-number'],
      force: flags.force,
      unlocked: {installationKey: flags['installation-key'], sourceOnly: flags['source-only']},
      validation,
      waitTime: flags.wait,
    }

    return {
      async: flags.async ?? false,
      buildOptions,
      buildOrgUsername: flags['build-org'],
      devhubUsername,
      mode,
      noDependencies: flags['no-dependencies'],
      packages,
      projectDir,
      resolvedPackages,
      sfpmConfig,
      waitMinutes: flags.wait,
    }
  }

  private async resolveValidationsInline(
    descriptors: PendingValidationDescriptor[],
    resolved: ResolvedBuildFlags,
    externalBus?: ValidationEventBus,
  ): Promise<void> {
    const projectService = await ProjectService.getInstance(resolved.projectDir);

    if (externalBus) {
      // Ink path: the bus is already wired to uiBus by attachBuildBridge.
      // Run the resolver silently — the App handles all display.
      const resolver = new ValidationResolver(
        projectService.getDefinitionProvider(),
        projectService.getProjectGraph(),
        noopLogger,
        externalBus,
      );
      const results = await resolver.resolve(descriptors, {
        maxWaitMs: resolved.waitMinutes * 60 * 1000,
      });
      const failures: string[] = [];
      for (const [packageName, result] of results) {
        if (result.status === 'failed') failures.push(`${packageName}: ${result.error}`);
      }

      if (failures.length > 0) this.error(`Validation failed for ${failures.length} package(s)`, {exit: 1});
      return;
    }

    // Plain / json path: Listr-based renderer with explicit begin/end lifecycle.
    const validationBus = new ValidationEventBus()
    const renderer = new ValidationProgressRenderer(resolved.mode, {
      error: msg => this.error(msg),
      log: msg => this.log(msg),
    })
    renderer.attachTo(validationBus)

    // In interactive mode the Listr renderer owns the terminal — pass noopLogger
    // so pino doesn't write to stderr and corrupt the cursor state.
    const resolverLogger = resolved.mode === 'interactive' ? noopLogger : this.sfpmLogger;
    const resolver = new ValidationResolver(
      projectService.getDefinitionProvider(),
      projectService.getProjectGraph(),
      resolverLogger,
      validationBus,
    );

    // Wait for the spinner to be live BEFORE starting work — otherwise the
    // event-loop-heavy resolver starves the Listr async render setup.
    await renderer.begin(descriptors.map(d => d.packageName));
    const results = await resolver.resolve(descriptors, {
      maxWaitMs: resolved.waitMinutes * 60 * 1000,
    });
    await renderer.end();

    const failures: string[] = [];
    for (const [packageName, result] of results) {
      if (result.status === 'failed') failures.push(`${packageName}: ${result.error}`);
    }

    if (failures.length > 0) this.error(`Validation failed for ${failures.length} package(s)`, {exit: 1});
  }
}
