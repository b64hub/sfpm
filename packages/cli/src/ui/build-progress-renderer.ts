import type {
  AnalyzerCompleteEvent, AnalyzersCompleteEvent,
  AnalyzersStartEvent,
  AnalyzerStartEvent,
  BuildCompleteEvent,
  BuilderCompleteEvent,
  BuildErrorEvent,
  BuilderStartEvent,
  BuildEventBus,
  BuildSkippedEvent,
  BuildStartEvent,
  ConnectionCompleteEvent,
  ConnectionStartEvent,
  CreateCompleteEvent,
  CreateProgressEvent,
  CreateStartEvent,
  HookCompleteEvent,
  HooksCompleteEvent,
  HooksStartEvent,
  OrchestrationCompleteEvent,
  OrchestrationEventBus,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationPackageCompleteEvent,
  OrchestrationStartEvent,
  StageCompleteEvent,
  StageStartEvent,
  TaskCompleteEvent,
  TaskSkippedEvent,
  TaskStartEvent,
  ValidationQueuedEvent,
} from '@b64hub/sfpm-core';

import chalk from 'chalk';
import ora, {Ora} from 'ora';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {infoBox} from './boxes.js';
import {OrchestrationListrManager} from './orchestration-listr.js';
import {calculateDuration, formatDuration} from './renderer-utils.js';

export type {OutputMode} from './renderer-utils.js';

/**
 * Timing information tracked internally
 */
interface TimingInfo {
  analyzersStart?: Date;
  builderStart?: Date;
  buildStart?: Date;
  connectionStart?: Date;
  createStart?: Date;
  hooksStart?: Date;
  stageStart?: Date;
}

/**
 * Renders build progress in different output modes.
 *
 * ## Orchestration mode (multi-package)
 *
 * All packages are flat root-level Listr tasks with two sub-tasks each:
 * 1. **Build sub-task** — updated via `updateBuildTitle()` as phases progress
 * 2. **Validation queued** — static marker, shown when validation is triggered
 *
 * On success sub-tasks collapse; on failure they stay expanded.
 *
 * ## Standalone mode (single-package)
 *
 * Uses ora spinners and inline log output (no Listr).
 */
export class BuildProgressRenderer {
  private buildResult?: {
    error?: Error;
    packageVersionId?: string;
    success: boolean;
  };
  /**
   * Event configuration mapping events to handlers
   */
  private eventConfigs: Record<string, EventConfig> = {
    'analyzer:complete': {description: 'Analyzer complete', handler: this.handleAnalyzerComplete.bind(this)},
    'analyzer:start': {description: 'Analyzer started', handler: this.handleAnalyzerStart.bind(this)},
    'analyzers:complete': {description: 'All analyzers complete', handler: this.handleAnalyzersComplete.bind(this)},
    'analyzers:start': {description: 'Analyzers started', handler: this.handleAnalyzersStart.bind(this)},
    'builder:complete': {description: 'Builder complete', handler: this.handleBuilderComplete.bind(this)},
    'builder:start': {description: 'Builder started', handler: this.handleBuilderStart.bind(this)},
    complete: {description: 'Build completed', handler: this.handleBuildComplete.bind(this)},
    'connection:complete': {description: 'Connection complete', handler: this.handleConnectionComplete.bind(this)},
    'connection:start': {description: 'Connection started', handler: this.handleConnectionStart.bind(this)},
    'create:complete': {description: 'Package creation complete', handler: this.handleCreateComplete.bind(this)},
    'create:progress': {description: 'Package creation progress', handler: this.handleCreateProgress.bind(this)},
    'create:start': {description: 'Package creation started', handler: this.handleCreateStart.bind(this)},
    error: {description: 'Build failed', handler: this.handleBuildError.bind(this)},
    'hook:complete': {description: 'Hook complete', handler: this.handleHookComplete.bind(this)},
    'hooks:complete': {description: 'All hooks complete', handler: this.handleHooksComplete.bind(this)},
    'hooks:start': {description: 'Hooks started', handler: this.handleHooksStart.bind(this)},
    skip: {description: 'Build skipped', handler: this.handleBuildSkipped.bind(this)},
    'stage:complete': {description: 'Staging complete', handler: this.handleStageComplete.bind(this)},
    'stage:start': {description: 'Staging package', handler: this.handleStageStart.bind(this)},
    start: {description: 'Build started', handler: this.handleBuildStart.bind(this)},
    'task:complete': {description: 'Task complete', handler: this.handleTaskComplete.bind(this)},
    'task:skipped': {description: 'Task skipped', handler: this.handleTaskSkipped.bind(this)},
    'task:start': {description: 'Task started', handler: this.handleTaskStart.bind(this)},
    'validate:queued': {description: 'Validation queued', handler: this.handleValidationQueued.bind(this)},
  };
  private events: EventLog[] = [];
  /**
   * Tracks completed hook names per package for rolling title updates.
   */
  private hookProgress: Map<string, {completed: string[]; total: string[]}> = new Map();
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
    'package:complete': {description: 'Package complete', handler: this.handleOrchestrationPackageComplete.bind(this)},
    start: {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
  private packageVersions: Map<string, string> = new Map();
  /**
   * Tracks running analyzer names per package for rolling title updates.
   */
  private runningAnalyzers: Map<string, {completed: string[]; total: string[]}> = new Map();
  /**
   * Tracks skip reasons per package so they survive across event handlers.
   * Populated by `build:skipped`, consumed by `orchestration:package:complete`.
   */
  private skippedReasons: Map<string, string> = new Map();
  private spinner?: Ora;
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode}) {
    this.logger = options.logger;
    this.mode = options.mode;
    this.listr = new OrchestrationListrManager();
  }

  /**
   * Attach this renderer to typed event buses.
   */
  public attachTo(buildBus: BuildEventBus, orchestrationBus?: OrchestrationEventBus): void {
    // Attach all configured build event handlers
    for (const [eventName, config] of Object.entries(this.eventConfigs)) {
      buildBus.on(eventName as any, (data: any) => {
        this.logEvent(eventName, data);
        config.handler(data);
      });
    }

    // Attach orchestration event handlers if an orchestration bus is provided
    if (orchestrationBus) {
      for (const [eventName, config] of Object.entries(this.orchestrationEventConfigs)) {
        orchestrationBus.on(eventName as any, (data: any) => {
          config.handler(data);
        });
      }
    }
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /**
   * Get JSON output for --json flag
   */
  public getJsonOutput(): any {
    const duration = this.timings.buildStart && this.events.length > 0
      ? this.events.at(-1)!.timestamp.getTime() - this.timings.buildStart.getTime()
      : 0;

    return {
      duration,
      events: this.events,
      result: this.buildResult,
      status: this.buildResult?.success ? 'success' : 'error',
    };
  }

  /**
   * Handle error display
   */
  public handleError(error: Error): void {
    if (!this.isInteractive()) return;

    this.stopSpinner(false);
  }

  // ========================================================================
  // Build Event Handlers
  // ========================================================================

  private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
    if (!this.isInteractive()) return;

    const progress = this.runningAnalyzers.get(event.packageName);
    if (progress) {
      progress.completed.push(event.analyzerName);
    }

    if (this.isOrchestrating()) {
      const remaining = progress
        ? progress.total.filter(n => !progress.completed.includes(n))
        : [];
      const label = remaining.length > 0
        ? `analyzing - ${remaining.join(', ')}`
        : 'analyzing...';
      this.listr.updateBuildTitle(event.packageName, label);
    }
  }

  private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.analyzersStart, event.timestamp);

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `analyzed (${event.completedCount}) ${chalk.gray(`(${duration})`)}`,
      );
    } else {
      const analyzerText = event.completedCount === 1 ? 'analyzer' : 'analyzers';
      this.logger.log(chalk.green(`✔ Completed ${event.completedCount} ${analyzerText} in ${duration}`));
      this.logger.log('');
    }

    this.runningAnalyzers.delete(event.packageName);
  }

  private handleAnalyzersStart(event: AnalyzersStartEvent): void {
    this.timings.analyzersStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (event.analyzerCount === 0) return;

    this.runningAnalyzers.set(event.packageName, {completed: [], total: []});

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'analyzing...');
    } else {
      const analyzerText = event.analyzerCount === 1 ? 'analyzer' : 'analyzers';
      this.logger.log(chalk.dim(`Running ${event.analyzerCount} ${analyzerText}...`));
    }
  }

  private handleAnalyzerStart(event: AnalyzerStartEvent): void {
    const progress = this.runningAnalyzers.get(event.packageName);
    if (progress) {
      progress.total.push(event.analyzerName);
    }

    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      const names = progress ? progress.total.filter(n => !progress.completed.includes(n)) : [event.analyzerName];
      this.listr.updateBuildTitle(event.packageName, `analyzing - ${names.join(', ')}`);
    }
  }

  private handleBuildComplete(event: BuildCompleteEvent): void {
    this.buildResult = {
      packageVersionId: event.packageVersionId,
      success: true,
    };

    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.buildStart, event.timestamp);

    if (this.isOrchestrating()) {
      if (event.version) this.packageVersions.set(event.packageName, event.version);
      const version = event.version ? ` @ ${event.version}` : '';
      // Update build sub-task to show artifact line
      this.listr.updateBuildTitle(event.packageName, `artifact${chalk.dim(version)}`);
      // Update package root title to collapsed form
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)}${chalk.dim(version)} ${chalk.gray(`(${duration})`)}`,
      );
    } else {
      this.logger.log(chalk.green.bold('\n✓ Build complete!') + chalk.gray(` (${duration})`));
    }
  }

  private handleBuilderComplete(_event: BuilderCompleteEvent): void {
    // No UI update needed — subsequent events (build:complete, etc.) handle display
  }

  private handleBuildError(event: BuildErrorEvent): void {
    this.buildResult = {
      error: event.error,
      success: false,
    };

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `${chalk.red('failed')} in ${event.phase}`,
      );
    } else if (this.isInteractive()) {
      this.stopSpinner(false);
      this.logger.error(chalk.red.bold(`✗ Build failed in ${event.phase} phase: `) + event.error.message);
    } else {
      this.logger.error(chalk.red.bold(`✗ Build failed in ${event.phase} phase: `) + event.error.message);
    }
  }

  private handleBuilderStart(event: BuilderStartEvent): void {
    this.timings.builderStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `executing ${event.packageType} builder...`);
    } else {
      this.startSpinner(`Executing ${event.packageType} package builder...`);
    }
  }

  private handleBuildSkipped(event: BuildSkippedEvent): void {
    this.buildResult = {
      success: true,
    };

    if (!this.isInteractive()) return;

    const reasonLabels: Record<string, string> = {
      'empty-package': 'package contains no deployable components',
      'no-changes': 'no source changes detected',
    };
    const reasonLabel = reasonLabels[event.reason] ?? event.reason;

    // Store the reason so orchestration:package:complete can use it
    this.skippedReasons.set(event.packageName, reasonLabel);

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, chalk.dim(reasonLabel));
    } else {
      // Stop any active spinner before showing the box
      this.stopSpinner(true, chalk.yellow('Build skipped'));

      const duration = calculateDuration(this.timings.buildStart, event.timestamp);

      const entries: Record<string, string> = {
        Package: chalk.cyan(event.packageName),
        Type: event.packageType,
      };

      if (event.version) {
        entries.Version = event.version;
      }

      if (event.latestVersion) {
        entries['Latest Build'] = event.latestVersion;
      }

      if (event.sourceHash) {
        entries['Source Hash'] = chalk.dim(event.sourceHash);
      }

      if (event.artifactPath) {
        entries.Artifact = chalk.dim(event.artifactPath);
      }

      entries.Reason = chalk.yellow(reasonLabel.charAt(0).toUpperCase() + reasonLabel.slice(1));
      entries.Duration = duration;

      this.logger.log(infoBox('Build Skipped', entries));
    }
  }

  private handleBuildStart(event: BuildStartEvent): void {
    this.timings.buildStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `building (${event.packageType})...`);
    } else {
      this.logger.log(chalk.bold(`\nBuilding package: ${chalk.cyan(event.packageName)} (${event.packageType})\n`));
    }
  }

  private handleConnectionComplete(event: ConnectionCompleteEvent): void {
    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.connectionStart, event.timestamp);

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `connected to ${chalk.yellow(event.username)} ${chalk.gray(`(${duration})`)}`,
      );
    } else {
      this.stopSpinner(true, chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
    }
  }

  private handleConnectionStart(event: ConnectionStartEvent): void {
    this.timings.connectionStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `connecting to ${event.orgType}: ${chalk.yellow(event.username)}...`,
      );
    } else {
      this.startSpinner(`Connecting to ${event.orgType}: ${event.username}`);
    }
  }

  private handleCreateComplete(event: CreateCompleteEvent): void {
    if (!this.isInteractive()) return;

    const elapsed = this.timings.createStart
      ? formatDuration(Date.now() - this.timings.createStart.getTime())
      : '';
    const elapsedSuffix = elapsed ? chalk.dim(` (${elapsed})`) : '';

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `created ${event.versionNumber}${elapsedSuffix}`);
    } else {
      this.stopSpinner(true, chalk.green(`Package ${event.packageName}@${event.versionNumber} successfully created with Id: ${event.packageVersionId}`) + elapsedSuffix);

      // Build package details entries
      const entries: Record<string, string> = {
        'Package Name': event.packageName,
        'Version ID': event.packageVersionId,
        'Version Number': event.versionNumber,
      };

      if (event.packageId) {
        entries['Package ID'] = event.packageId;
      }

      if (event.status) {
        entries.Status = event.status;
      }

      if (event.totalNumberOfMetadataFiles !== undefined) {
        entries['Metadata Files'] = String(event.totalNumberOfMetadataFiles);
      }

      if (event.codeCoverage !== null && event.codeCoverage !== undefined) {
        const coverageColor = event.hasPassedCodeCoverageCheck ? chalk.green : chalk.yellow;
        entries['Code Coverage'] = coverageColor(`${event.codeCoverage}%`);
      }

      if (event.createdDate) {
        entries.Created = event.createdDate;
      }

      // Display the box
      this.logger.log('');
      this.logger.log(infoBox('Package Version Details', entries));
      this.logger.log('');
    }
  }

  private handleCreateProgress(event: CreateProgressEvent): void {
    if (!this.isInteractive() || !event.message) return;

    const elapsed = this.timings.createStart
      ? formatDuration(Date.now() - this.timings.createStart.getTime())
      : '';
    const elapsedSuffix = elapsed ? chalk.dim(` (${elapsed})`) : '';

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `creating: ${event.message}${elapsedSuffix}`);
    } else if (this.spinner) {
      this.spinner.text = `Creating package version: ${event.message}${elapsedSuffix}`;
    }
  }

  private handleCreateStart(event: CreateStartEvent): void {
    if (!this.isInteractive()) return;

    this.timings.createStart = event.timestamp;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `creating version ${event.versionNumber}...`);
    } else {
      this.startSpinner(`Creating package version ${event.packageName}@${event.versionNumber}`);
    }
  }

  private handleHookComplete(event: HookCompleteEvent): void {
    if (!this.isInteractive()) return;

    const progress = this.hookProgress.get(event.packageName);
    if (progress) {
      progress.completed.push(event.hookName);
    }

    if (this.isOrchestrating()) {
      const remaining = progress
        ? progress.total.filter(n => !progress.completed.includes(n))
        : [];
      const label = remaining.length > 0
        ? `hooks [${event.timing}-${event.operation}] - ${remaining.join(', ')}`
        : `hooks [${event.timing}-${event.operation}]...`;
      this.listr.updateBuildTitle(event.packageName, label);
    }
  }

  private handleHooksComplete(event: HooksCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.hooksStart, event.timestamp);

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `hooks [${event.timing}-${event.operation}] (${event.completedCount}) ${chalk.gray(`(${duration})`)}`,
      );
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
      this.listr.updateBuildTitle(
        event.packageName,
        `hooks [${event.timing}-${event.operation}] - ${event.hookNames.join(', ')}`,
      );
    } else {
      const hookText = event.hookCount === 1 ? 'hook' : 'hooks';
      this.logger.log(chalk.dim(`Running ${event.hookCount} ${hookText} [${event.timing}-${event.operation}] - ${event.hookNames.join(', ')}...`));
    }
  }

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent): void {
    this.logEvent('orchestration:complete', event);

    if (!this.isInteractive()) return;

    this.listr.destroy();
  }

  // ========================================================================
  // Orchestration Event Handlers
  // ========================================================================

  private handleOrchestrationLevelComplete(event: OrchestrationLevelCompleteEvent): void {
    this.logEvent('orchestration:level:complete', event);
  }

  private handleOrchestrationLevelStart(event: OrchestrationLevelStartEvent): void {
    this.logEvent('orchestration:level:start', event);

    if (!this.isInteractive()) return;

    this.listr.onLevelStart(event);
  }

  private handleOrchestrationPackageComplete(event: OrchestrationPackageCompleteEvent): void {
    this.logEvent('orchestration:package:complete', event);

    if (!this.isInteractive()) return;

    const duration = formatDuration(event.duration);

    if (event.skipped) {
      const reason = this.skippedReasons.get(event.packageName);
      const reasonSuffix = reason ? ` ${chalk.dim(`— ${reason}`)}` : '';
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.yellow('○')} ${chalk.cyan(event.packageName)}${reasonSuffix}`,
      );

      this.listr.resolvePackage(event.packageName);
    } else if (event.success) {
      const version = this.packageVersions.get(event.packageName);
      const versionSuffix = version ? ` @ ${version}` : '';
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)}${chalk.dim(versionSuffix)} ${chalk.gray(`(${duration})`)}`,
      );

      this.listr.resolvePackage(event.packageName);
    } else {
      const errorMsg = event.error || 'Build failed';
      this.listr.rejectPackage(event.packageName, errorMsg);
    }
  }

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    if (!this.isInteractive()) return;

    const levelText = event.totalLevels === 1 ? 'level' : 'levels';
    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    this.logger.log(chalk.bold(`\nBuilding ${chalk.cyan(String(event.totalPackages))} ${pkgText} across ${chalk.cyan(String(event.totalLevels))} ${levelText}`));

    if (event.includeDependencies) {
      this.logger.log(chalk.dim('  Dependencies auto-included'));
    }

    this.logger.log('');

    this.listr.start(event.packageNames);
  }

  private handleStageComplete(event: StageCompleteEvent): void {
    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.stageStart, event.timestamp);

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `staged ${event.componentCount} components ${chalk.gray(`(${duration})`)}`,
      );
    } else {
      this.stopSpinner(
        true,
        chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`),
      );
    }
  }

  private handleStageStart(event: StageStartEvent): void {
    this.timings.stageStart = event.timestamp;

    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, 'staging...');
    } else {
      this.startSpinner('Staging package');
    }
  }

  private handleTaskComplete(event: TaskCompleteEvent): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      const status = event.success ? chalk.green('✓') : chalk.red('✗');
      this.listr.updateBuildTitle(event.packageName, `${status} ${event.taskName}`);
    } else if (event.success) {
      this.stopSpinner(true, chalk.gray(event.taskName));
    } else {
      this.stopSpinner(false, chalk.red(`${event.taskName} failed`));
    }
  }

  private handleTaskSkipped(event: TaskSkippedEvent): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(
        event.packageName,
        `${chalk.yellow('○')} ${event.taskName} skipped`,
      );
    } else {
      this.stopSpinner(true, chalk.yellow(`${event.taskName} skipped: ${event.reason}`));
    }
  }

  private handleTaskStart(event: TaskStartEvent): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.updateBuildTitle(event.packageName, `${event.taskType}: ${event.taskName}`);
    } else {
      this.startSpinner(`  ${chalk.cyan(event.taskType)}: ${event.taskName}`);
    }
  }

  private handleValidationQueued(event: ValidationQueuedEvent): void {
    if (!this.isInteractive()) return;

    if (this.isOrchestrating()) {
      this.listr.markValidationQueued(event.packageName);
    }
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

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

  private logEvent(type: string, data: any): void {
    this.events.push({data, timestamp: data.timestamp ?? new Date(), type});
  }

  /**
   * Start a spinner with the given text
   */
  private startSpinner(text: string): void {
    if (this.spinner) {
      this.spinner.stop();
    }

    this.spinner = ora(text).start();
  }

  /**
   * Stop the active spinner
   */
  private stopSpinner(success: boolean, text?: string): void {
    if (this.spinner) {
      if (success) {
        this.spinner.succeed(text);
      } else {
        this.spinner.fail(text);
      }

      this.spinner = undefined;
    }
  }
}
