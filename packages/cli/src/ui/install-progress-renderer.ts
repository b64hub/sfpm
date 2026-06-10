import type {
  HookCompleteEvent,
  HooksCompleteEvent,
  HooksStartEvent,
  InstallEventBus,
  InstallStartEvent,
  OrchestrationCompleteEvent,
  OrchestrationEventBus,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationStartEvent,
} from '@b64hub/sfpm-core';

import boxen from 'boxen';
import chalk from 'chalk';
import ora, {Ora} from 'ora';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {successBox, warningBox} from './boxes.js';
import {OrchestrationListrManager} from './orchestration-listr.js';
import {formatDuration} from './renderer-utils.js';

export type {OutputMode} from './renderer-utils.js';

/**
 * Timing information tracked internally
 */
interface TimingInfo {
  connectionStart?: Date;
  deploymentStart?: Date;
  hooksStart?: Date;
  installStart?: Date;
}

/**
 * Renders install progress in different output modes
 */
export class InstallProgressRenderer {
  /**
   * Event configuration mapping events to handlers
   */
  private eventConfigs: Record<string, EventConfig> = {
    complete: {description: 'Install completed', handler: this.handleInstallComplete.bind(this)},
    'connection:complete': {description: 'Connected to org', handler: this.handleConnectionComplete.bind(this)},
    'connection:start': {description: 'Connecting to org', handler: this.handleConnectionStart.bind(this)},
    'deploy:complete': {description: 'Deployment completed', handler: this.handleDeploymentComplete.bind(this)},
    'deploy:progress': {description: 'Deployment progress', handler: this.handleDeploymentProgress.bind(this)},
    'deploy:start': {description: 'Deployment started', handler: this.handleDeploymentStart.bind(this)},
    error: {description: 'Install error', handler: this.handleInstallError.bind(this)},
    'hook:complete': {description: 'Hook complete', handler: this.handleHookComplete.bind(this)},
    'hooks:complete': {description: 'All hooks complete', handler: this.handleHooksComplete.bind(this)},
    'hooks:start': {description: 'Hooks started', handler: this.handleHooksStart.bind(this)},
    skip: {description: 'Install skipped', handler: this.handleInstallSkip.bind(this)},
    start: {description: 'Install started', handler: this.handleInstallStart.bind(this)},
    'version:complete': {description: 'Version install completed', handler: this.handleVersionInstallComplete.bind(this)},
    'version:progress': {description: 'Version install progress', handler: this.handleVersionInstallProgress.bind(this)},
    'version:start': {description: 'Version install started', handler: this.handleVersionInstallStart.bind(this)},
  };
  private events: EventLog[] = [];
  /**
   * Tracks completed hook names per package for rolling title updates.
   */
  private hookProgress: Map<string, {completed: string[]; total: string[]}> = new Map();
  private installResult?: {
    error?: Error;
    success: boolean;
  };
  private listr: OrchestrationListrManager;
  private logger: OutputLogger;
  private mode: OutputMode;
  /**
   * Event configuration for orchestration-level events
   */
  private orchestrationEventConfigs: Record<string, EventConfig> = {
    complete: {description: 'Orchestration complete', handler: this.handleOrchestrationComplete.bind(this)},
    'level:complete': {description: 'Level complete', handler: this.handleOrchestrationLevelComplete.bind(this)},
    'level:start': {description: 'Level started', handler: this.handleOrchestrationLevelStart.bind(this)},
    start: {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
  private spinner?: Ora;
  private targetOrg?: string;
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode; targetOrg?: string}) {
    this.logger = options.logger;
    this.mode = options.mode;
    this.targetOrg = options.targetOrg;
    this.listr = new OrchestrationListrManager();
  }

  /**
   * Attach renderer to typed event buses.
   */
  public attachTo(installBus: InstallEventBus, orchestrationBus?: OrchestrationEventBus): void {
    for (const [event, config] of Object.entries(this.eventConfigs)) {
      installBus.on(event as any, (data: any) => {
        this.logEvent(event, data);
        config.handler(data);
      });
    }

    // Attach orchestration event handlers if an orchestration bus is provided
    if (orchestrationBus) {
      for (const [event, config] of Object.entries(this.orchestrationEventConfigs)) {
        orchestrationBus.on(event as any, (data: any) => {
          config.handler(data);
        });
      }
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
   * Handle connection complete event
   */
  private handleConnectionComplete(event: any): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `connected to ${chalk.yellow(event.username)}`,
      );
    } else {
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

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'connecting to org...');
    } else {
      this.spinner?.start(`Connecting to org ${chalk.yellow(event.username)}...`);
    }
  }

  /**
   * Handle deployment complete event
   */
  private handleDeploymentComplete(event: any): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      const components = event.numberComponentsDeployed ? ` (${event.numberComponentsDeployed} components)` : '';
      this.listr.updateBuildTitle(event.packageName, `deployed${components}`);
    } else {
      this.spinner?.succeed(chalk.green('Metadata deployed successfully'));
      if (event.numberComponentsDeployed) {
        this.logger.log(chalk.gray(`  Deployed ${event.numberComponentsDeployed} components`));
      }
    }
  }

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
      progressText = `deploying: ${status} (${componentsDeployed}/${componentsTotal} - ${percentage}%)`;
    } else {
      progressText = `deploying: ${status}`;
    }

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, progressText);
    } else if (this.spinner) {
      this.spinner.text = progressText;
    }
  }

  /**
   * Handle deployment start event
   */
  private handleDeploymentStart(event: any): void {
    this.timings.deploymentStart = new Date();
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'deploying metadata...');
    } else {
      this.spinner = ora({
        color: 'cyan',
        text: `Deploying metadata to ${chalk.yellow(event.targetOrg)}...`,
      }).start();
    }
  }

  private handleHookComplete(event: HookCompleteEvent): void {
    if (!this.isInteractive()) return;

    const progress = this.hookProgress.get(event.packageName);
    if (progress) {
      progress.completed.push(event.hookName);
    }

    if (this.isOrchestrating()) {
      this.listr.completeHook(event.packageName, event.hookName);
    }
  }

  // ========================================================================
  // Connection Events
  // ========================================================================

  private handleHooksComplete(event: HooksCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const duration = this.timings.hooksStart
      ? formatDuration(Date.now() - this.timings.hooksStart.getTime())
      : '';

    if (this.isOrchestrating()) {
      this.listr.completeHooks(event.packageName, event.completedCount, event.timing, event.operation, duration);
    } else {
      const hookText = event.completedCount === 1 ? 'hook' : 'hooks';
      this.logger.log(chalk.green(`✔ Completed ${event.completedCount} ${hookText} [${event.timing}-${event.operation}] in ${duration}`));
    }

    this.hookProgress.delete(event.packageName);
  }

  private handleHooksStart(event: HooksStartEvent): void {
    this.timings.hooksStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (event.hookCount === 0) return;

    this.hookProgress.set(event.packageName, {completed: [], total: [...event.hookNames]});

    if (this.isOrchestrating()) {
      this.listr.startHooks(event.packageName, event.hookNames, event.timing, event.operation);
    } else {
      const hookText = event.hookCount === 1 ? 'hook' : 'hooks';
      this.logger.log(chalk.dim(`Running ${event.hookCount} ${hookText} [${event.timing}-${event.operation}] - ${event.hookNames.join(', ')}...`));
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

    if (this.isOrchestrating()) {
      const version = event.versionNumber ? `@${event.versionNumber}` : '';
      this.listr.updateBuildTitle(event.packageName, `installed${version}`);
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(`${event.packageName}${version}`)}`,
      );
      this.listr.resolvePackage(event.packageName);
    } else {
      this.spinner?.succeed(chalk.green(`Successfully installed ${chalk.bold(event.packageName)}`));

      const duration = this.timings.installStart
        ? Date.now() - this.timings.installStart.getTime()
        : 0;

      this.logger.log(successBox('Installation Complete', {
        Duration: formatDuration(duration),
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

    if (this.isOrchestrating()) {
      const errorMsg = typeof event.error === 'string' ? event.error : event.error?.message ?? 'Installation failed';
      this.listr.rejectPackage(event.packageName, errorMsg);
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
    if (this.isOrchestrating()) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.yellow('○')} ${chalk.cyan(event.packageName)} ${chalk.dim(`— ${reason}`)}`,
      );
      this.listr.resolvePackage(event.packageName);
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

    if (this.isOrchestrating()) {
      const version = event.versionNumber ? `@${event.versionNumber}` : '';
      this.listr.updateBuildTitle(event.packageName, `installing${version}...`);
    } else {
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
    this.listr.destroy();

    this.logger.log('');

    const succeeded = event.results.filter(r => r.success && !r.skipped).length;
    const failed = event.results.filter(r => !r.success && !r.skipped).length;
    const skipped = event.results.filter(r => r.skipped).length;
    const duration = formatDuration(event.totalDuration);

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

    this.listr.onLevelStart(event);
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

    this.listr.start(event.packageNames);
  }

  /**
   * Handle version install complete event
   */
  private handleVersionInstallComplete(event: any): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'version installed');
    } else {
      this.spinner?.succeed(chalk.green('Package version installed'));
    }
  }

  /**
   * Handle version install progress event
   */
  private handleVersionInstallProgress(event: any): void {
    if (!this.isInteractive()) return;

    const status = event.status || 'InProgress';

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `installing version: ${status}`);
    } else if (this.spinner) {
      this.spinner.text = `Installing package version: ${status}`;
    }
  }

  /**
   * Handle version install start event
   */
  private handleVersionInstallStart(event: any): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'installing package version...');
    } else {
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
    return this.listr.isActive();
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
}
