import type {
  InstallOrchestrator, InstallStartEvent, OrchestrationCompleteEvent,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationStartEvent,
  PackageInstaller,
} from '@b64/sfpm-core';

import boxen from 'boxen';
import chalk from 'chalk';
import {Listr} from 'listr2';
import ora, {Ora} from 'ora';

import {successBox, warningBox} from './boxes.js';

/**
 * Output modes for install progress rendering
 */
export type OutputMode = 'interactive' | 'json' | 'quiet';

/**
 * Logger interface for rendering output
 */
interface OutputLogger {
  error: (message: Error | string) => void;
  log: (message: string) => void;
}

/**
 * Collected event data for JSON output
 */
interface EventLog {
  data: any;
  timestamp: Date;
  type: string;
}

/**
 * Timing information tracked internally
 */
interface TimingInfo {
  connectionStart?: Date;
  deploymentStart?: Date;
  installStart?: Date;
}

/**
 * Event handler function type
 */
type EventHandler<T = any> = (event: T) => void;

/**
 * Event configuration for systematic handling
 */
interface EventConfig {
  description: string;
  handler: EventHandler;
}

/**
 * Renders install progress in different output modes
 */
/**
 * Deferred promise holder for level or package tasks.
 */
interface Deferred {
  promise: Promise<void>;
  reject: (err: Error) => void;
  resolve: () => void;
}

function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, reject, resolve};
}

/**
 * Renders install progress in different output modes
 */
export class InstallProgressRenderer {
  /**
   * Event configuration mapping events to handlers
   */
  private eventConfigs: Record<string, EventConfig> = {
    'connection:complete': {description: 'Connected to org', handler: this.handleConnectionComplete.bind(this)},
    'connection:start': {description: 'Connecting to org', handler: this.handleConnectionStart.bind(this)},
    'deployment:complete': {description: 'Deployment completed', handler: this.handleDeploymentComplete.bind(this)},
    'deployment:progress': {description: 'Deployment progress', handler: this.handleDeploymentProgress.bind(this)},
    'deployment:start': {description: 'Deployment started', handler: this.handleDeploymentStart.bind(this)},
    'install:complete': {description: 'Install completed', handler: this.handleInstallComplete.bind(this)},
    'install:error': {description: 'Install error', handler: this.handleInstallError.bind(this)},
    'install:skip': {description: 'Install skipped', handler: this.handleInstallSkip.bind(this)},
    'install:start': {description: 'Install started', handler: this.handleInstallStart.bind(this)},
    'version-install:complete': {description: 'Version install completed', handler: this.handleVersionInstallComplete.bind(this)},
    'version-install:progress': {description: 'Version install progress', handler: this.handleVersionInstallProgress.bind(this)},
    'version-install:start': {description: 'Version install started', handler: this.handleVersionInstallStart.bind(this)},
  };
  private events: EventLog[] = [];
  private installResult?: {
    error?: Error;
    success: boolean;
  };
  /**
   * Deferred promises for each orchestration level.
   * Created at orchestration:start, resolved at each orchestration:level:start.
   */
  private levelDeferreds: Deferred[] = [];
  private logger: OutputLogger;
  private mode: OutputMode;
  /**
   * Event configuration for orchestration-level events
   */
  private orchestrationEventConfigs: Record<string, EventConfig> = {
    'orchestration:complete': {description: 'Orchestration complete', handler: this.handleOrchestrationComplete.bind(this)},
    'orchestration:level:complete': {description: 'Level complete', handler: this.handleOrchestrationLevelComplete.bind(this)},
    'orchestration:level:start': {description: 'Level started', handler: this.handleOrchestrationLevelStart.bind(this)},
    'orchestration:start': {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
  /**
   * Pre-created deferred promises for each package in the current orchestration level.
   * Populated synchronously in handleOrchestrationLevelStart so resolve/reject are
   * available even before Listr sub-tasks populate packageTasks.
   */
  private packageDeferreds: Map<string, Deferred> = new Map();
  private packageTasks: Map<string, any> = new Map();
  /**
   * Single root Listr instance that persists across all orchestration levels.
   * Created once at orchestration:start, replaced per-level instances.
   */
  private rootListr?: Listr;
  private spinner?: Ora;
  private targetOrg?: string;
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode; targetOrg?: string}) {
    this.logger = options.logger;
    this.mode = options.mode;
    this.targetOrg = options.targetOrg;
  }

  /**
   * Attach renderer to a PackageInstaller or InstallOrchestrator instance
   */
  public attachTo(emitter: InstallOrchestrator | PackageInstaller): void {
    for (const [event, config] of Object.entries(this.eventConfigs)) {
      (emitter as any).on(event, (data: any) => {
        this.logEvent(event, data);
        config.handler(data);
      });
    }

    // Attach orchestration event handlers (no-ops if emitter is a plain PackageInstaller)
    for (const [event, config] of Object.entries(this.orchestrationEventConfigs)) {
      (emitter as any).on(event, (data: any) => {
        config.handler(data);
      });
    }
  }

  /**
   * Get JSON output with all collected events
   */
  public getJsonOutput(): any {
    return {
      error: this.installResult?.error?.message,
      events: this.events,
      success: this.installResult?.success ?? false,
      timings: {
        total: this.timings.installStart
          ? Date.now() - this.timings.installStart.getTime()
          : undefined,
      },
    };
  }

  /**
   * Handle errors during installation
   */
  public handleError(error: Error): void {
    this.installResult = {
      error,
      success: false,
    };

    if (!this.isInteractive()) {
      if (this.mode === 'quiet') {
        this.logger.error(error);
      }

      return;
    }

    this.spinner?.fail(chalk.red('Installation failed'));

    this.logger.log(boxen(
      chalk.white(error.message),
      {
        borderColor: 'red',
        borderStyle: 'round',
        margin: {bottom: 1, top: 1},
        padding: 1,
        title: 'Installation Error',
        titleAlignment: 'center',
      },
    ));
  }

  /**
   * Format duration in human-readable format
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  /**
   * Look up the Listr sub-task for a package within the active orchestration level.
   * Returns undefined when running in standalone (non-orchestration) mode.
   */
  private getPackageTask(packageName: string): any | undefined {
    return this.packageTasks.get(packageName);
  }

  /**
   * Handle connection complete event
   */
  private handleConnectionComplete(event: any): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Connected to ${chalk.yellow(event.username)}`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner?.succeed(chalk.green(`Connected to org ${chalk.yellow(event.username)}`));
    }

    this.targetOrg = event.targetOrg ?? event.username;
  }

  /**
   * Handle connection start event
   */
  private handleConnectionStart(event: any): void {
    this.timings.connectionStart = new Date();
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Connecting to org...`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner?.start(`Connecting to org ${chalk.yellow(event.username)}...`);
    }
  }

  /**
   * Handle deployment complete event
   */
  private handleDeploymentComplete(event: any): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const components = event.numberComponentsDeployed ? ` (${event.numberComponentsDeployed} components)` : '';
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Deployed${components}`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner?.succeed(chalk.green('Metadata deployed successfully'));
      if (event.numberComponentsDeployed) {
        this.logger.log(chalk.gray(`  Deployed ${event.numberComponentsDeployed} components`));
      }
    }
  }

  // ========================================================================
  // Connection Events
  // ========================================================================

  /**
   * Handle deployment progress event
   */
  private handleDeploymentProgress(event: any): void {
    if (!this.isInteractive()) return;

    const status = event.status || 'InProgress';
    const componentsDeployed = event.numberComponentsDeployed || 0;
    const componentsTotal = event.numberComponentsTotal || 0;

    let progressText: string;
    if (componentsTotal > 0) {
      const percentage = Math.round((componentsDeployed / componentsTotal) * 100);
      progressText = `Deploying: ${status} (${componentsDeployed}/${componentsTotal} - ${percentage}%)`;
    } else {
      progressText = `Deploying: ${status}`;
    }

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${progressText}`,
      );
    } else if (!this.isOrchestrating() && this.spinner) {
      this.spinner.text = progressText;
    }
  }

  /**
   * Handle deployment start event
   */
  private handleDeploymentStart(event: any): void {
    this.timings.deploymentStart = new Date();
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Deploying metadata...`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner = ora({
        color: 'cyan',
        text: `Deploying metadata to ${chalk.yellow(event.targetOrg)}...`,
      }).start();
    }
  }

  // ========================================================================
  // Deployment Events (source packages)
  // ========================================================================

  /**
   * Handle install complete event — resolves the Listr sub-task in orchestration mode
   */
  private handleInstallComplete(event: any): void {
    this.installResult = {success: true};
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const version = event.versionNumber ? `@${event.versionNumber}` : '';
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.green('Installed')} ${chalk.cyan(`${event.packageName}${version}`)}`,
      );
      this.resolvePackageTask(event.packageName);
    } else if (this.isOrchestrating()) {
      // Listr task not ready yet — resolve via deferred directly
      this.resolvePackageTask(event.packageName);
    } else {
      this.spinner?.succeed(chalk.green(`Successfully installed ${chalk.bold(event.packageName)}`));

      const duration = this.timings.installStart
        ? Date.now() - this.timings.installStart.getTime()
        : 0;

      this.logger.log(successBox('Installation Complete', {
        Duration: this.formatDuration(duration),
        'Package Name': event.packageName,
        Source: event.source,
        'Target Org': event.targetOrg,
        'Version ID': event.packageVersionId,
        'Version Number': event.versionNumber,
      }));
    }
  }

  /**
   * Handle install error event — rejects the Listr sub-task in orchestration mode
   */
  private handleInstallError(event: any): void {
    this.installResult = {
      error: event.error,
      success: false,
    };

    if (!this.isInteractive()) {
      if (this.mode === 'quiet') {
        this.logger.error(event.error);
      }

      return;
    }

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const errorMsg = typeof event.error === 'string' ? event.error : event.error?.message ?? 'Installation failed';
      this.rejectPackageTask(event.packageName, errorMsg);
    } else if (this.isOrchestrating()) {
      // Listr task not ready yet — reject via deferred directly
      const errorMsg = typeof event.error === 'string' ? event.error : event.error?.message ?? 'Installation failed';
      this.rejectPackageTask(event.packageName, errorMsg);
    } else {
      this.spinner?.fail(chalk.red(`Failed to install ${chalk.bold(event.packageName)}`));
    }
  }

  /**
   * Handle install skip event — resolves the Listr sub-task with a skip message
   */
  private handleInstallSkip(event: any): void {
    if (!this.isInteractive()) return;

    const reason = event.reason || 'Already installed';
    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.yellow('Skipped')} ${chalk.cyan(event.packageName)} - ${reason}`,
      );
      this.resolvePackageTask(event.packageName);
    } else if (this.isOrchestrating()) {
      this.resolvePackageTask(event.packageName);
    } else {
      this.spinner?.info(chalk.yellow(`Skipped ${chalk.bold(event.packageName)}: ${reason}`));
    }
  }

  /**
   * Handle install start event
   */
  private handleInstallStart(event: InstallStartEvent): void {
    this.timings.installStart = new Date();
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const version = event.versionNumber ? `@${event.versionNumber}` : '';
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(`${event.packageName}${version}`)} - Starting installation...`,
      );
    } else if (!this.isOrchestrating()) {
      const packageDisplay = event.versionNumber
        ? `${event.packageName}@${event.versionNumber}`
        : event.packageName;

      this.logger.log(chalk.bold(`Installing package: ${chalk.cyan(packageDisplay)} (${event.packageType})\n`));

      this.spinner = ora({
        color: 'cyan',
        text: `Installing ${chalk.cyan(event.packageName)} to ${chalk.yellow(event.targetOrg)}`,
      }).start();
    }
  }

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent): void {
    this.logEvent('orchestration:complete', event);

    if (!this.isInteractive()) return;

    // Cleanup \u2014 Listr rendering is done
    this.rootListr = undefined;
    this.levelDeferreds = [];
    this.packageDeferreds.clear();
    this.packageTasks.clear();

    this.logger.log('');

    const succeeded = event.results.filter(r => r.success && !r.skipped).length;
    const failed = event.results.filter(r => !r.success && !r.skipped).length;
    const skipped = event.results.filter(r => r.skipped).length;
    const duration = this.formatDuration(event.totalDuration);

    const entries: Record<string, string> = {
      Succeeded: String(succeeded),
      'Total Packages': String(event.results.length),
    };
    if (failed > 0) entries.Failed = chalk.red(String(failed));
    if (skipped > 0) entries.Skipped = chalk.yellow(String(skipped));
    entries.Duration = duration;

    const allSucceeded = failed === 0;
    const title = allSucceeded ? 'Install Orchestration Complete' : 'Install Orchestration Complete (with failures)';

    if (allSucceeded) {
      this.logger.log(successBox(title, entries));
    } else {
      this.logger.log(warningBox(title, entries));
    }
  }

  private handleOrchestrationLevelComplete(event: OrchestrationLevelCompleteEvent): void {
    this.logEvent('orchestration:level:complete', event);
    // No cleanup needed — Listr keeps completed level tasks visible
    // and the next level task starts automatically (sequential root).
  }

  private handleOrchestrationLevelStart(event: OrchestrationLevelStartEvent): void {
    this.logEvent('orchestration:level:start', event);

    if (!this.isInteractive()) return;

    // Pre-create package deferreds SYNCHRONOUSLY so resolve/reject are
    // available immediately, even if install events fire before Listr
    // sub-tasks populate the packageTasks map.
    this.packageDeferreds.clear();
    this.packageTasks.clear();
    for (const name of event.packages) {
      this.packageDeferreds.set(name, createDeferred());
    }

    // Resolve the level deferred to unblock the corresponding Listr level task.
    // The task function was waiting on this promise before creating subtasks.
    const levelDeferred = this.levelDeferreds[event.level];
    if (levelDeferred) {
      (levelDeferred as any).data = event;
      levelDeferred.resolve();
    }
  }

  // ========================================================================
  // Version Install Events (unlocked packages)
  // ========================================================================

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    if (!this.isInteractive()) return;

    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    this.logger.log(chalk.bold(`\nInstalling ${chalk.cyan(String(event.totalPackages))} ${pkgText} to ${chalk.cyan(this.targetOrg)}`));

    if (event.includeDependencies) {
      this.logger.log(chalk.dim('  Dependencies auto-included'));
    }

    this.logger.log('');

    // Create one deferred per level — resolved when orchestration:level:start fires.
    this.levelDeferreds = [];
    for (let i = 0; i < event.totalLevels; i++) {
      this.levelDeferreds.push(createDeferred());
    }

    // Build a single root Listr with one sequential task per level.
    // Each level task awaits its deferred, then creates concurrent package subtasks.
    this.rootListr = new Listr(
      this.levelDeferreds.map((deferred, i) => ({
        task: async (_ctx: any, task: any): Promise<Listr> => {
          // Block until orchestration:level:start resolves this deferred
          await deferred.promise;
          const levelEvent = (deferred as any).data as OrchestrationLevelStartEvent;

          // Update the level title with actual data
          const count = levelEvent.packages.length;
          const levelPkgText = count === 1 ? 'package' : 'packages';
          task.title = `Installing ${chalk.cyan(String(count))} ${levelPkgText} to ${chalk.yellow(this.targetOrg)}`;

          // Build subtasks — packageDeferreds are already populated synchronously
          // in handleOrchestrationLevelStart before the level deferred was resolved.
          return task.newListr(
            levelEvent.packages.map((name: string) => {
              const detail = levelEvent.packageDetails?.find((d: any) => d.name === name);
              const version = detail?.version ? `@${detail.version}` : '';
              return {
                task: (_c: any, _t: any) => {
                  this.packageTasks.set(name, _t);
                  return this.packageDeferreds.get(name)!.promise;
                },
                title: `${chalk.cyan(`${name}${version}`)}`,
              };
            }),
            {
              concurrent: true,
              exitOnError: false,
              rendererOptions: {
                collapseErrors: false,
              },
            },
          );
        },
        title: chalk.dim(`Level ${i + 1} - waiting...`),
      })),
      {
        concurrent: false,
        rendererOptions: {
          collapseSubtasks: false,
        },
      },
    );

    this.rootListr.run().catch(() => {
      // Errors are handled by individual task handlers
    });
  }

  /**
   * Handle version install complete event
   */
  private handleVersionInstallComplete(event: any): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Version installed`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner?.succeed(chalk.green('Package version installed'));
    }
  }

  /**
   * Handle version install progress event
   */
  private handleVersionInstallProgress(event: any): void {
    if (!this.isInteractive()) return;

    const status = event.status || 'InProgress';

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Installing version: ${status}`,
      );
    } else if (!this.isOrchestrating() && this.spinner) {
      this.spinner.text = `Installing package version: ${status}`;
    }
  }

  /**
   * Handle version install start event
   */
  private handleVersionInstallStart(event: any): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.updatePackageTaskTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Installing package version...`,
      );
    } else if (!this.isOrchestrating()) {
      this.spinner = ora({
        color: 'cyan',
        text: `Installing package version ${event.packageVersionId ?? ''}...`,
      }).start();
    }
  }

  /**
   * Check if renderer is in interactive mode
   */
  private isInteractive(): boolean {
    return this.mode === 'interactive';
  }

  /**
   * Check if an orchestration level is currently active.
   * Used to prevent standalone spinner creation during orchestration —
   * all output should flow through Listr sub-tasks instead.
   */
  private isOrchestrating(): boolean {
    return this.rootListr !== undefined;
  }

  /**
   * Log an event for JSON output and quiet mode
   */
  private logEvent(type: string, data: any): void {
    this.events.push({
      data,
      timestamp: new Date(),
      type,
    });
  }

  /**
   * Reject the Listr sub-task promise for a package (marks it as failed).
   * Uses the pre-created deferred from packageDeferreds — safe to call even
   * before Listr has populated the packageTasks map.
   */
  private rejectPackageTask(packageName: string, error: string): void {
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(error));
  }

  /**
   * Resolve the Listr sub-task promise for a package (marks it as done).
   * Uses the pre-created deferred from packageDeferreds — safe to call even
   * before Listr has populated the packageTasks map.
   */
  private resolvePackageTask(packageName: string): void {
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.resolve();
  }

  /**
   * Update the title of a package's Listr sub-task.
   */
  private updatePackageTaskTitle(packageName: string, title: string): void {
    const task = this.getPackageTask(packageName);
    if (task) {
      task.title = title;
    }
  }
}
