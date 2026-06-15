import {
  BuildEventBus,
  BuildOrchestrationTask, BuildOrchestrator, type BuildOrchestratorOptions,
  type BuildWatcherPayload,
  LifecycleEngine,
  type OrchestrationResult,
  PackageType,
  type PendingValidationDescriptor, ProjectService, ValidationEventBus, ValidationResolver,
  type WatcherState,
} from '@b64hub/sfpm-core'
import {ScratchOrgProvider} from '@b64hub/sfpm-orgs'
import {createTracer} from '@b64hub/sfpm-telemetry'
import {
  Args, Flags,
} from '@oclif/core'
import {ConfigAggregator, Org} from '@salesforce/core'
// Register SFDMU data builder (side-effect import triggers decorator registration)
import '@b64hub/sfpm-sfdmu'
import chalk from 'chalk'
import path from 'node:path'
import ora from 'ora'

import SfpmCommand from '../../sfpm-command.js'
import {BuildProgressRenderer, OutputMode} from '../../ui/build-progress-renderer.js'
import {renderBuildSummary} from '../../ui/build-summary.js'
import {ValidationProgressRenderer} from '../../ui/validation-progress-renderer.js'
import {resolvePackageInputs} from '../../utils/package-resolver.js'
import {forkWatcher} from '../../utils/watcher.js'

interface ResolvedBuildFlags {
  async: boolean;
  autoCreatedBuildOrg?: {hubOrg: Org; username: string};
  buildOptions: BuildOrchestratorOptions;
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
  static override description = 'build one or more packages'
  /**
   * Lifecycle stage: **build**
   *
   * Operations executed per package:
   * - `build:pre`  — before each package build starts
   * - `build:post` — after each package build succeeds
   */
  static override examples = [
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub',
    '<%= config.bin %> <%= command.id %> my-package -v my-devhub --quiet',
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
    json: Flags.boolean({description: 'output as JSON for CI/CD', exclusive: ['quiet']}),
    'no-dependencies': Flags.boolean({default: false, description: 'build the specified packages without their transitive dependencies'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
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
      default: 'full',
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
      // Route to single-package or orchestrated build
      if (resolved.resolvedPackages.length === 1 && resolved.noDependencies) {
        await this.buildSingle(resolved)
      } else {
        await this.buildOrchestrated(resolved)
      }
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

    const orchestrator = new BuildOrchestrator(
      projectConfig,
      projectGraph,
      {...resolved.buildOptions, includeDependencies: !resolved.noDependencies},
      this.sfpmLogger,
      resolved.projectDir,
    )

    const renderer = new BuildProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode: resolved.mode,
    });

    renderer.attachTo(orchestrator.buildBus, orchestrator.orchestrationBus)

    const tracer = createTracer({serviceName: 'sfpm-cli'})
    tracer.subscribe({build: orchestrator.buildBus, orchestration: orchestrator.orchestrationBus})

    try {
      const result = await orchestrator.buildAll(resolved.resolvedPackages)
      await tracer.shutdown()

      if (resolved.mode === 'json') {
        this.logJson(result)
      }

      if (!result.success) {
        const failedNames = result.failedPackages.join(', ')
        this.error(`Build failed for: ${failedNames}`, {exit: 1})
      }

      await this.handleValidationResults(result.pendingValidations, resolved)

      // Render build summary line
      const summaryLogger = {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      }
      renderBuildSummary(
        result.results.map(r => ({
          failed: !r.success && !r.skipped,
          packageName: r.packageName,
          skipped: r.skipped ?? false,
        })),
        result.duration,
        summaryLogger,
      )
    } catch (error) {
      renderer.handleError(error as Error)
      if (resolved.mode === 'json') {
        this.logJson({error: (error as Error).message, success: false})
      }

      throw error
    }
  }

  private async buildSingle(resolved: ResolvedBuildFlags): Promise<void> {
    const projectService = await ProjectService.getInstance(resolved.projectDir);
    const projectConfig = projectService.getDefinitionProvider();

    const buildBus = new BuildEventBus()
    const task = new BuildOrchestrationTask(
      projectConfig,
      resolved.buildOptions,
      this.sfpmLogger,
      resolved.projectDir,
      buildBus,
    )

    const renderer = new BuildProgressRenderer({
      logger: {
        error: (msgOrError: Error | string) => this.error(msgOrError),
        log: (msg: string) => this.log(msg),
      },
      mode: resolved.mode,
    });

    renderer.attachTo(buildBus)

    try {
      await task.setup()
      const result = await task.processSinglePackage(resolved.resolvedPackages[0], 0)

      if (resolved.mode === 'json') {
        this.logJson(result)
      }

      if (!result.success) {
        this.error(`Build failed for: ${resolved.resolvedPackages[0]}${result.error ? ` — ${result.error}` : ''}`, {exit: 1})
      }

      const pendingValidations = result.pendingValidation ? [result.pendingValidation] : []
      await this.handleValidationResults(pendingValidations, resolved)
    } catch (error) {
      renderer.handleError(error as Error)
      if (resolved.mode === 'json') {
        this.logJson({error: (error as Error).message, success: false})
      }

      throw error
    }
  }

  /**
   * Delete an auto-created scratch org after the build completes.
   */
  private async cleanupBuildOrg(resolved: ResolvedBuildFlags): Promise<void> {
    if (!resolved.autoCreatedBuildOrg) return

    const {hubOrg, username} = resolved.autoCreatedBuildOrg
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
    if (resolved.buildOptions.buildOrg || resolved.buildOptions.validation === 'none' || resolved.buildOptions.validation === 'local') return

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

    if (!resolved.buildOptions.devhubUsername) {
      this.error('A target dev hub is required to auto-create a build org for source validation. Specify one with --target-dev-hub (-v).', {exit: 1})
    }

    const spinner = resolved.mode === 'interactive'
      ? ora('Creating scratch org for source validation...').start()
      : undefined

    const hubOrg = await Org.create({aliasOrUsername: resolved.buildOptions.devhubUsername})
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

      resolved.buildOptions.buildOrg = username
      resolved.autoCreatedBuildOrg = {hubOrg, username}
    } catch (error) {
      spinner?.fail('Failed to create scratch org')
      throw error
    }
  }

  /**
   * Handle pending validations: resolve inline or fork a background watcher.
   *
   * - No `--async`: resolve inline with ValidationResolver, fail on any failures.
   * - `--async`: fork watcher process for background polling.
   */
  private async handleValidationResults(
    pendingValidations: PendingValidationDescriptor[],
    resolved: ResolvedBuildFlags,
  ): Promise<void> {
    if (pendingValidations.length === 0) return

    if (resolved.async) {
      await this.handleValidationResutlsAsync(pendingValidations, resolved);
      return;
    }

    const validationBus = new ValidationEventBus()
    const renderer = new ValidationProgressRenderer(resolved.mode, {
      error: msg => this.error(msg),
      log: msg => this.log(msg),
    })
    renderer.attachTo(validationBus)

    const resolver = new ValidationResolver(this.sfpmLogger, validationBus);
    const results = await resolver.resolve(pendingValidations, {
      maxWaitMs: resolved.waitMinutes * 60 * 1000,
    });

    const failures: string[] = [];
    for (const [packageName, result] of results) {
      if (result.status === 'failed') {
        failures.push(`${packageName}: ${result.error}`);
      }
    }

    if (failures.length > 0) {
      this.error(`Validation failed for ${failures.length} package(s)`, {exit: 1})
    }
  }

  private async handleValidationResutlsAsync(pendingValidations: PendingValidationDescriptor[], resolved: ResolvedBuildFlags): Promise<void> {
    this.log(chalk.yellow('\nValidation results will be available asynchronously.'));

    const payload: BuildWatcherPayload = {
      ...(resolved.autoCreatedBuildOrg && {
        cleanupBuildOrg: {
          devhubUsername: resolved.buildOptions.devhubUsername!,
          username: resolved.autoCreatedBuildOrg.username,
        },
      }),
      targets: pendingValidations.map(pv => ({
        packageName: pv.packageName,
        packageVersionCreateRequestId: pv.operationId,
      })),
    };

    const state: WatcherState = {
      auth: {username: resolved.buildOptions.devhubUsername ?? ''},
      createdAt: Date.now(),
      jobType: 'build',
      payload,
      projectDir: resolved.projectDir,
      timeoutMs: resolved.waitMinutes * 60 * 1000,
      updatedAt: Date.now(),
      watcherStatus: 'starting',
    };

    const {id, pid} = await forkWatcher(state);
    const pkgNames = pendingValidations.map(pv => pv.packageName).join(', ');

    if (resolved.mode === 'json') {
      this.logJson({
        packages: pkgNames,
        stateId: id,
        watcherPid: pid,
      });
    } else if (resolved.mode !== 'quiet') {
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
    const resolvedPackages = await resolvePackageInputs(packages, projectConfig, {json: flags.json})

    // Resolve validation level: --no-validation → 'none', --validation=X → X, default → 'full'
    const validation = (flags.validation === 'false' ? 'none' : flags.validation ?? 'full') as 'full' | 'local' | 'none' | 'org';

    // Resolve devhub (not required when validation doesn't need an org)
    const needsOrg = validation === 'org' || validation === 'full';
    let devhubUsername = flags['target-dev-hub']
    if (!devhubUsername && needsOrg) {
      const configAggregator = await ConfigAggregator.create()
      devhubUsername = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined
    }

    if (!devhubUsername && needsOrg) {
      this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1})
    }

    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    const buildOptions: BuildOrchestratorOptions = {
      buildNumber: flags['build-number'],
      buildOrg: flags['build-org'],
      devhubUsername,
      force: flags.force,
      ignoreFilesConfig: sfpmConfig.ignoreFiles,
      installationKey: flags['installation-key'],
      validation,
      waitTime: flags.wait,
    }

    return {
      async: flags.async ?? false,
      buildOptions,
      mode,
      noDependencies: flags['no-dependencies'],
      packages,
      projectDir,
      resolvedPackages,
      sfpmConfig,
      waitMinutes: flags.wait,
    }
  }
}
