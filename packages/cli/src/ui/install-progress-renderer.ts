import type {
  HookCompleteEvent,
  HooksCompleteEvent,
  HooksStartEvent,
  InstallEventBus,
  InstallResult,
  InstallStartEvent,
  OrchestrationCompleteEvent,
  OrchestrationEventBus,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationStartEvent,
} from '@b64hub/sfpm-core';

import chalk from 'chalk';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';
import type {DisplayStrategy} from './strategies/display-strategy.js';

import {formatDuration} from './renderer-utils.js';
import {createDisplayStrategy} from './strategies/index.js';

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
 * Renders install progress by translating install/orchestration events
 * into display strategy calls.
 *
 * The renderer owns event-to-semantic translation. The display strategy
 * (interactive, plain, silent) owns how that is rendered.
 */
export class InstallProgressRenderer {
  private readonly display: DisplayStrategy;
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
  /**
   * Event configuration for orchestration-level events
   */
  private orchestrationEventConfigs: Record<string, EventConfig> = {
    complete: {description: 'Orchestration complete', handler: this.handleOrchestrationComplete.bind(this)},
    'level:complete': {description: 'Level complete', handler: this.handleOrchestrationLevelComplete.bind(this)},
    'level:start': {description: 'Level started', handler: this.handleOrchestrationLevelStart.bind(this)},
    start: {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
  private targetOrg?: string;
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode; targetOrg?: string}) {
    this.display = createDisplayStrategy(options.mode, options.logger);
    this.targetOrg = options.targetOrg;
  }

  /**
   * Attach renderer to typed event buses.
   */
  public attachTo(installBus: InstallEventBus, orchestrationBus?: OrchestrationEventBus<InstallResult>): void {
    for (const [event, config] of Object.entries(this.eventConfigs)) {
      installBus.on(event as any, (data: any) => {
        this.logEvent(event, data);
        config.handler(data);
      });
    }

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

    this.display.error(error);
  }

  // ========================================================================
  // Connection Events
  // ========================================================================

  private handleConnectionComplete(event: any): void {
    this.display.subtaskUpdate(event.packageName, 'install', `connected to ${chalk.yellow(event.username)}`);
    this.targetOrg = event.targetOrg ?? event.username;
  }

  private handleConnectionStart(event: any): void {
    this.timings.connectionStart = new Date();
    this.display.subtaskStart(event.packageName, `connecting to org ${chalk.yellow(event.username)}`);
  }

  // ========================================================================
  // Deployment Events (source packages)
  // ========================================================================

  private handleDeploymentComplete(event: any): void {
    const components = event.numberComponentsDeployed ? ` (${event.numberComponentsDeployed} components)` : '';
    this.display.subtaskUpdate(event.packageName, 'install', `deployed${components}`);
  }

  private handleDeploymentProgress(event: any): void {
    const status = event.status || 'InProgress';
    const componentsDeployed = event.numberComponentsDeployed || 0;
    const componentsTotal = event.numberComponentsTotal || 0;

    let progressText: string;
    if (componentsTotal > 0) {
      const percentage = Math.round((componentsDeployed / componentsTotal) * 100);
      progressText = `deploying: ${status} (${componentsDeployed}/${componentsTotal} — ${percentage}%)`;
    } else {
      progressText = `deploying: ${status}`;
    }

    this.display.subtaskUpdate(event.packageName, 'install', progressText);
  }

  private handleDeploymentStart(event: any): void {
    this.timings.deploymentStart = new Date();
    this.display.subtaskStart(event.packageName, `deploying metadata to ${chalk.yellow(event.targetOrg)}`);
  }

  // ========================================================================
  // Hook Events
  // ========================================================================

  private handleHookComplete(event: HookCompleteEvent): void {
    const progress = this.hookProgress.get(event.packageName);
    if (progress) {
      progress.completed.push(event.hookName);
    }
  }

  private handleHooksComplete(event: HooksCompleteEvent): void {
    if (event.completedCount === 0) return;

    const duration = this.timings.hooksStart
      ? formatDuration(Date.now() - this.timings.hooksStart.getTime())
      : '';

    const hookText = event.completedCount === 1 ? 'hook' : 'hooks';
    const phase = `${event.timing}-hooks`;

    this.display.subtaskComplete(event.packageName, phase, `${event.timing}-${event.operation} ${hookText} (${event.completedCount}) ${chalk.gray(`(${duration})`)}`);
    this.hookProgress.delete(event.packageName);
  }

  private handleHooksStart(event: HooksStartEvent): void {
    this.timings.hooksStart = event.timestamp;
    if (event.hookCount === 0) return;

    this.hookProgress.set(event.packageName, {completed: [], total: [...event.hookNames]});

    const phase = `${event.timing}-hooks`;
    const label = event.hookNames.map(n => chalk.dim(n)).join(chalk.dim(', '));
    this.display.subtaskStart(event.packageName, phase);
    this.display.subtaskUpdate(event.packageName, phase, `running ${event.timing}-${event.operation} hooks — ${label}`);
  }

  // ========================================================================
  // Install Events
  // ========================================================================

  private handleInstallComplete(event: any): void {
    this.installResult = {success: true};

    const version = event.versionNumber ? `@${event.versionNumber}` : '';
    const duration = this.timings.installStart
      ? formatDuration(Date.now() - this.timings.installStart.getTime())
      : '';

    this.display.subtaskUpdate(event.packageName, 'install', `installed${version}`);
    this.display.packageComplete(event.packageName, duration);
  }

  private handleInstallError(event: any): void {
    this.installResult = {
      error: event.error,
      success: false,
    };

    const errorMsg = typeof event.error === 'string' ? event.error : event.error?.message ?? 'Installation failed';
    this.display.packageFail(event.packageName, errorMsg);
  }

  private handleInstallSkip(event: any): void {
    const reason = event.reason || 'Already installed';
    this.display.packageSkip(event.packageName, reason);
  }

  private handleInstallStart(event: InstallStartEvent): void {
    this.timings.installStart = new Date();

    const version = event.versionNumber ? `@${event.versionNumber}` : '';
    this.display.packageStart(event.packageName);
    this.display.subtaskStart(event.packageName, `installing${version} (${event.packageType})`);
  }

  // ========================================================================
  // Orchestration Events
  // ========================================================================

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent<InstallResult>): void {
    this.logEvent('orchestration:complete', event);

    const succeeded = event.results.filter(r => r.success && !r.skipped).length;
    const failed = event.results.filter(r => !r.success && !r.skipped).length;
    const skipped = event.results.filter(r => r.skipped).length;

    this.display.complete({
      duration: formatDuration(event.totalDuration),
      failed,
      packages: event.results.map(r => ({
        error: r.error,
        name: r.packageName,
        skipped: r.skipped,
        success: r.success,
      })),
      skipped,
      succeeded,
    });
  }

  private handleOrchestrationLevelComplete(event: OrchestrationLevelCompleteEvent): void {
    this.logEvent('orchestration:level:complete', event);
  }

  private handleOrchestrationLevelStart(event: OrchestrationLevelStartEvent): void {
    this.logEvent('orchestration:level:start', event);
    this.display.levelStart(event.level, event.packages);
  }

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    let title = `Installing ${chalk.cyan(String(event.totalPackages))} ${pkgText} to ${chalk.cyan(this.targetOrg)}`;

    if (event.includeDependencies) {
      title += chalk.dim('\n  Dependencies auto-included');
    }

    this.display.start(title, event.packageNames);
  }

  // ========================================================================
  // Version Install Events (unlocked packages)
  // ========================================================================

  private handleVersionInstallComplete(event: any): void {
    this.display.subtaskUpdate(event.packageName, 'install', 'version installed');
  }

  private handleVersionInstallProgress(event: any): void {
    const status = event.status || 'InProgress';
    this.display.subtaskUpdate(event.packageName, 'install', `installing version: ${status}`);
  }

  private handleVersionInstallStart(event: any): void {
    this.display.subtaskStart(event.packageName, 'installing package version');
  }

  // ========================================================================
  // Utility
  // ========================================================================

  /**
   * Log an event for JSON output
   */
  private logEvent(type: string, data: any): void {
    this.events.push({
      data,
      timestamp: new Date(),
      type,
    });
  }
}
