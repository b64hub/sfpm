import type {
  InstallOrchestrator, OrchestrationCompleteEvent,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationPackageCompleteEvent,
  OrchestrationStartEvent,
  PackageInstaller,
} from '@b64/sfpm-core';

import {ux} from '@oclif/core';
import boxen from 'boxen';
import chalk from 'chalk';
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
  private logger: OutputLogger;
  private mode: OutputMode;
  /**
   * Event configuration for orchestration-level events
   */
  private orchestrationEventConfigs: Record<string, EventConfig> = {
    'orchestration:complete': {description: 'Orchestration complete', handler: this.handleOrchestrationComplete.bind(this)},
    'orchestration:level:complete': {description: 'Level complete', handler: this.handleOrchestrationLevelComplete.bind(this)},
    'orchestration:level:start': {description: 'Level started', handler: this.handleOrchestrationLevelStart.bind(this)},
    'orchestration:package:complete': {description: 'Package complete', handler: this.handleOrchestrationPackageComplete.bind(this)},
    'orchestration:start': {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
  private orchestrationSpinner?: Ora;
  private spinner?: Ora;
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode}) {
    this.logger = options.logger;
    this.mode = options.mode;
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
   * Handle connection complete event
   */
  private handleConnectionComplete(event: any): void {
    if (!this.isInteractive()) {
      return;
    }

    this.spinner?.succeed(chalk.green(`Connected to org ${chalk.yellow(event.targetOrg)}`));
  }

  /**
   * Handle connection start event
   */
  private handleConnectionStart(event: any): void {
    this.timings.connectionStart = new Date();

    if (!this.isInteractive()) {
      return;
    }

    this.spinner?.start(`Connecting to org ${chalk.yellow(event.targetOrg)}...`);
  }

  /**
   * Handle deployment complete event
   */
  private handleDeploymentComplete(event: any): void {
    if (!this.isInteractive()) {
      return;
    }

    this.spinner?.succeed(chalk.green('Metadata deployed successfully'));

    if (event.numberComponentsDeployed) {
      this.logger.log(chalk.gray(`  Deployed ${event.numberComponentsDeployed} components`));
    }
  }

  /**
   * Handle deployment progress event
   */
  private handleDeploymentProgress(event: any): void {
    if (!this.isInteractive() || !this.spinner) {
      return;
    }

    const status = event.status || 'InProgress';
    const componentsDeployed = event.numberComponentsDeployed || 0;
    const componentsTotal = event.numberComponentsTotal || 0;

    let progressText = `Deploying metadata: ${status}`;
    if (componentsTotal > 0) {
      const percentage = Math.round((componentsDeployed / componentsTotal) * 100);
      progressText += ` (${componentsDeployed}/${componentsTotal} - ${percentage}%)`;
    }

    this.spinner.text = progressText;
  }

  /**
   * Handle deployment start event
   */
  private handleDeploymentStart(event: any): void {
    this.timings.deploymentStart = new Date();

    if (!this.isInteractive()) {
      return;
    }

    this.spinner = ora({
      color: 'cyan',
      text: `Deploying metadata to ${chalk.yellow(event.targetOrg)}...`,
    }).start();
  }

  /**
   * Handle install complete event
   */
  private handleInstallComplete(event: any): void {
    this.installResult = {success: true};

    if (!this.isInteractive()) {
      return;
    }

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

  /**
   * Handle install error event
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

    this.spinner?.fail(chalk.red(`Failed to install ${chalk.bold(event.packageName)}`));
  }

  /**
   * Handle install start event
   */
  private handleInstallStart(event: any): void {
    this.timings.installStart = new Date();

    if (!this.isInteractive()) {
      return;
    }

    const packageDisplay = event.packageVersion
      ? `${event.packageName}@${event.packageVersion}`
      : event.packageName;

    this.logger.log(chalk.bold(`Installing package: ${chalk.cyan(packageDisplay)} (${event.packageType})\n`));

    this.spinner = ora({
      color: 'cyan',
      text: `Installing ${chalk.cyan(event.packageName)} to ${chalk.yellow(event.targetOrg)}`,
    }).start();
  }

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent): void {
    this.logEvent('orchestration:complete', event);

    if (!this.isInteractive()) return;

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

    if (!this.isInteractive()) return;

    const hasFailures = event.failed.length > 0;
    if (hasFailures) {
      this.orchestrationSpinner?.fail(chalk.red(`${event.failed.length} failed`));
    } else {
      this.orchestrationSpinner?.succeed(chalk.green('Done'));
    }

    this.orchestrationSpinner = undefined;
    this.logger.log('');
  }

  private handleOrchestrationLevelStart(event: OrchestrationLevelStartEvent): void {
    this.logEvent('orchestration:level:start', event);

    if (!this.isInteractive()) return;

    const pkgText = event.packages.length === 1 ? 'package' : 'packages';
    this.orchestrationSpinner = ora({
      color: 'cyan',
      text: `Installing ${chalk.cyan(String(event.packages.length))} ${pkgText}`,
    }).start();
  }

  private handleOrchestrationPackageComplete(event: OrchestrationPackageCompleteEvent): void {
    this.logEvent('orchestration:package:complete', event);

    if (!this.isInteractive()) return;

    const duration = this.formatDuration(event.duration);

    this.orchestrationSpinner?.stop();

    if (event.skipped) {
      this.logger.log(`  ${chalk.yellow('\u2298')} ${chalk.yellow(event.packageName)} ${chalk.dim('skipped')} ${chalk.gray(`(${duration})`)}`);
    } else if (event.success) {
      this.logger.log(`  ${chalk.green('\u2713')} ${chalk.green(event.packageName)} ${chalk.gray(`(${duration})`)}`);
    } else {
      this.logger.log(`  ${chalk.red('\u2717')} ${chalk.red(event.packageName)} ${chalk.gray(`(${duration})`)}${event.error ? chalk.red(` - ${event.error}`) : ''}`);
    }

    this.orchestrationSpinner?.start();
  }

  // ========================================================================
  // Orchestration Event Handlers
  // ========================================================================

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    if (!this.isInteractive()) return;

    const levelText = event.totalLevels === 1 ? 'level' : 'levels';
    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    this.logger.log(chalk.bold(`\nInstalling ${chalk.cyan(String(event.totalPackages))} ${pkgText} in ${chalk.cyan(String(event.totalLevels))} ${levelText}\n`));

    if (event.includeDependencies) {
      this.logger.log(chalk.dim('  Dependencies auto-included\n'));
    }
  }

  /**
   * Handle version install complete event
   */
  private handleVersionInstallComplete(event: any): void {
    if (!this.isInteractive()) {
      return;
    }

    this.spinner?.succeed(chalk.green('Package version installed successfully'));
  }

  /**
   * Handle version install progress event
   */
  private handleVersionInstallProgress(event: any): void {
    if (!this.isInteractive() || !this.spinner) {
      return;
    }

    const status = event.status || 'InProgress';
    this.spinner.text = `Installing package: ${status}`;
  }

  /**
   * Handle version install start event
   */
  private handleVersionInstallStart(event: any): void {
    if (!this.isInteractive()) {
      return;
    }

    this.spinner = ora({
      color: 'cyan',
      text: `Installing package version ${chalk.cyan(event.packageVersionId)}...`,
    }).start();
  }

  /**
   * Check if renderer is in interactive mode
   */
  private isInteractive(): boolean {
    return this.mode === 'interactive';
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
