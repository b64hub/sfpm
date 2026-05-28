import type {
  AnalyzerCompleteEvent, AnalyzersCompleteEvent,
  AnalyzersStartEvent,
  AnalyzerStartEvent,
  BuildCompleteEvent,
  BuilderCompleteEvent,
  BuildErrorEvent,
  BuilderStartEvent,
  BuildOrchestrator,
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
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationPackageCompleteEvent,
  OrchestrationStartEvent,
  PackageBuilder,
  StageCompleteEvent,
  StageStartEvent,
  TaskCompleteEvent,
  TaskSkippedEvent,
  TaskStartEvent,
} from '@b64hub/sfpm-core';

import chalk from 'chalk';
import ora, {Ora} from 'ora';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {infoBox, successBox, warningBox} from './boxes.js';
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
 * Renders build progress in different output modes
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
    'build:complete': {description: 'Build completed', handler: this.handleBuildComplete.bind(this)},
    'build:error': {description: 'Build failed', handler: this.handleBuildError.bind(this)},
    'build:skipped': {description: 'Build skipped', handler: this.handleBuildSkipped.bind(this)},
    'build:start': {description: 'Build started', handler: this.handleBuildStart.bind(this)},
    'builder:complete': {description: 'Builder complete', handler: this.handleBuilderComplete.bind(this)},
    'builder:start': {description: 'Builder started', handler: this.handleBuilderStart.bind(this)},
    'connection:complete': {description: 'Connection complete', handler: this.handleConnectionComplete.bind(this)},
    'connection:start': {description: 'Connection started', handler: this.handleConnectionStart.bind(this)},
    'hook:complete': {description: 'Hook complete', handler: this.handleHookComplete.bind(this)},
    'hooks:complete': {description: 'All hooks complete', handler: this.handleHooksComplete.bind(this)},
    'hooks:start': {description: 'Hooks started', handler: this.handleHooksStart.bind(this)},
    'stage:complete': {description: 'Staging complete', handler: this.handleStageComplete.bind(this)},
    'stage:start': {description: 'Staging package', handler: this.handleStageStart.bind(this)},
    'task:complete': {description: 'Task complete', handler: this.handleTaskComplete.bind(this)},
    'task:skipped': {description: 'Task skipped', handler: this.handleTaskSkipped.bind(this)},
    'task:start': {description: 'Task started', handler: this.handleTaskStart.bind(this)},
    'unlocked:create:complete': {description: 'Package creation complete', handler: this.handleCreateComplete.bind(this)},
    'unlocked:create:progress': {description: 'Package creation progress', handler: this.handleCreateProgress.bind(this)},
    'unlocked:create:start': {description: 'Package creation started', handler: this.handleCreateStart.bind(this)},
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
    'orchestration:complete': {description: 'Orchestration complete', handler: this.handleOrchestrationComplete.bind(this)},
    'orchestration:level:complete': {description: 'Level complete', handler: this.handleOrchestrationLevelComplete.bind(this)},
    'orchestration:level:start': {description: 'Level started', handler: this.handleOrchestrationLevelStart.bind(this)},
    'orchestration:package:complete': {description: 'Package complete', handler: this.handleOrchestrationPackageComplete.bind(this)},
    'orchestration:start': {description: 'Orchestration started', handler: this.handleOrchestrationStart.bind(this)},
  };
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
    this.listr = new OrchestrationListrManager(event => {
      const count = event.packages.length;
      const pkgText = count === 1 ? 'package' : 'packages';
      return `Building ${chalk.cyan(String(count))} ${pkgText}`;
    });
  }

  /**
   * Attach this renderer to a PackageBuilder or BuildOrchestrator instance
   */
  public attachTo(emitter: BuildOrchestrator | PackageBuilder): void {
    // Attach all configured build event handlers
    for (const [eventName, config] of Object.entries(this.eventConfigs)) {
      (emitter as any).on(eventName, (data: any) => {
        this.logEvent(eventName, data);
        config.handler(data);
      });
    }

    // Attach orchestration event handlers (no-ops if emitter is a plain PackageBuilder)
    for (const [eventName, config] of Object.entries(this.orchestrationEventConfigs)) {
      (emitter as any).on(eventName, (data: any) => {
        config.handler(data);
      });
    }
  }

  // ========================================================================
  // Spinner Management
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
  // Event Handlers
  // ========================================================================

  /**
   * Look up the Listr sub-task for a package within the active orchestration level.
   * Returns undefined when running in standalone (non-orchestration) mode.
   */
  private getPackageTask(packageName: string): any | undefined {
    return this.listr.getPackageTask(packageName);
  }

  private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
    if (!this.isInteractive()) return;

    const progress = this.runningAnalyzers.get(event.packageName);
    if (progress) {
      progress.completed.push(event.analyzerName);
    }

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const remaining = progress
        ? progress.total.filter(n => !progress.completed.includes(n))
        : [];
      const label = remaining.length > 0
        ? `Analyzing - ${remaining.join(', ')}`
        : 'Analyzing...';
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${label}`,
      );
    }
  }

  private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.analyzersStart, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Analyzed (${event.completedCount}) ${chalk.gray(`(${duration})`)}`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Analyzing...`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const names = progress ? progress.total.filter(n => !progress.completed.includes(n)) : [event.analyzerName];
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Analyzing - ${names.join(', ')}`,
      );
    }
  }

  private handleBuildComplete(event: BuildCompleteEvent): void {
    this.buildResult = {
      packageVersionId: event.packageVersionId,
      success: true,
    };

    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.buildStart, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.green('Built')} ${chalk.cyan(event.packageName)} ${chalk.gray(`(${duration})`)}`,
      );
    } else if (!this.isOrchestrating()) {
      this.logger.log(chalk.green.bold('\n✓ Build complete!') + chalk.gray(` (${duration})`));
    }
  }

  private handleBuilderComplete(event: BuilderCompleteEvent): void {
    // No UI update needed — subsequent events (build:complete, etc.) handle display
  }

  private handleBuildError(event: BuildErrorEvent): void {
    this.buildResult = {
      error: event.error,
      success: false,
    };

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.red('Failed')} ${chalk.cyan(event.packageName)} - ${event.phase}`,
      );
    } else if (this.isOrchestrating()) {
      // During orchestration, error display is handled by orchestration:package:complete
    } else {
      // Stop any active spinner
      if (this.isInteractive()) {
        this.stopSpinner(false);
      }

      // Always show errors, even in quiet mode
      this.logger.error(chalk.red.bold(`✗ Build failed in ${event.phase} phase: `) + event.error.message);
    }
  }

  private handleBuilderStart(event: BuilderStartEvent): void {
    this.timings.builderStart = event.timestamp;

    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Executing ${event.packageType} builder...`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.yellow('Skipped')} ${chalk.cyan(event.packageName)} - ${reasonLabel}`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Building (${event.packageType})...`,
      );
    } else if (!this.isOrchestrating()) {
      this.logger.log(chalk.bold(`\nBuilding package: ${chalk.cyan(event.packageName)} (${event.packageType})\n`));
    }
  }

  private handleConnectionComplete(event: ConnectionCompleteEvent): void {
    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.connectionStart, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Connected to ${chalk.yellow(event.username)} ${chalk.gray(`(${duration})`)}`,
      );
    } else if (!this.isOrchestrating()) {
      this.stopSpinner(true, chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
    }
  }

  private handleConnectionStart(event: ConnectionStartEvent): void {
    this.timings.connectionStart = event.timestamp;

    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Connecting to ${event.orgType}: ${chalk.yellow(event.username)}...`,
      );
    } else if (!this.isOrchestrating()) {
      this.startSpinner(`Connecting to ${event.orgType}: ${event.username}`);
    }
  }

  private handleCreateComplete(event: CreateCompleteEvent): void {
    if (!this.isInteractive()) return;

    const elapsed = this.timings.createStart
      ? formatDuration(Date.now() - this.timings.createStart.getTime())
      : '';
    const elapsedSuffix = elapsed ? chalk.dim(` (${elapsed})`) : '';

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const statusText = `Created ${event.versionNumber}${elapsedSuffix}`;
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${statusText}`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const statusText = `Creating: ${event.message}${elapsedSuffix}`;
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${statusText}`,
      );
    } else if (!this.isOrchestrating() && this.spinner) {
      this.spinner.text = `Creating package version: ${event.message}${elapsedSuffix}`;
    }
  }

  private handleCreateStart(event: CreateStartEvent): void {
    if (!this.isInteractive()) return;

    this.timings.createStart = event.timestamp;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const statusText = `Creating version ${event.versionNumber}...`;
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${statusText}`,
      );
    } else if (!this.isOrchestrating()) {
      this.startSpinner(`Creating package version ${event.packageName}@${event.versionNumber}`);
    }
  }

  private handleHookComplete(event: HookCompleteEvent): void {
    if (!this.isInteractive()) return;

    const progress = this.hookProgress.get(event.packageName);
    if (progress) {
      progress.completed.push(event.hookName);
    }

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const remaining = progress
        ? progress.total.filter(n => !progress.completed.includes(n))
        : [];
      const label = remaining.length > 0
        ? `Hooks [${event.timing}-${event.operation}] - ${remaining.join(', ')}`
        : `Hooks [${event.timing}-${event.operation}]...`;
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${label}`,
      );
    }
  }

  private handleHooksComplete(event: HooksCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.hooksStart, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Hooks [${event.timing}-${event.operation}] (${event.completedCount}) ${chalk.gray(`(${duration})`)}`,
      );
    } else if (!this.isOrchestrating()) {
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

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Hooks [${event.timing}-${event.operation}] - ${event.hookNames.join(', ')}`,
      );
    } else if (!this.isOrchestrating()) {
      const hookText = event.hookCount === 1 ? 'hook' : 'hooks';
      this.logger.log(chalk.dim(`Running ${event.hookCount} ${hookText} [${event.timing}-${event.operation}] - ${event.hookNames.join(', ')}...`));
    }
  }

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent): void {
    this.logEvent('orchestration:complete', event);

    if (!this.isInteractive()) return;

    // Cleanup — Listr rendering is done
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
    const title = allSucceeded ? 'Build Orchestration Complete' : 'Build Orchestration Complete (with failures)';

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
  // Orchestration Event Handlers
  // ========================================================================

  private handleOrchestrationPackageComplete(event: OrchestrationPackageCompleteEvent): void {
    this.logEvent('orchestration:package:complete', event);

    if (!this.isInteractive()) return;

    const duration = formatDuration(event.duration);

    if (event.skipped) {
      const reason = this.skippedReasons.get(event.packageName);
      const reasonSuffix = reason ? ` - ${reason}` : '';
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.yellow('Skipped')} ${chalk.cyan(event.packageName)}${reasonSuffix} ${chalk.gray(`(${duration})`)}`,
      );

      this.listr.resolvePackage(event.packageName);
    } else if (event.success) {
      // Title may already be set by build:complete — update with duration if not
      const task = this.getPackageTask(event.packageName);
      if (task && !task.title?.startsWith(chalk.green('Built'))) {
        this.listr.updatePackageTitle(
          event.packageName,
          `${chalk.green('Built')} ${chalk.cyan(event.packageName)} ${chalk.gray(`(${duration})`)}`,
        );
      }

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
    this.logger.log(chalk.bold(`\nBuilding ${chalk.cyan(String(event.totalPackages))} ${pkgText} in ${chalk.cyan(String(event.totalLevels))} ${levelText}`));

    if (event.includeDependencies) {
      this.logger.log(chalk.dim('  Dependencies auto-included'));
    }

    this.logger.log('');

    this.listr.start(event.totalLevels);
  }

  private handleStageComplete(event: StageCompleteEvent): void {
    if (!this.isInteractive()) return;

    const duration = calculateDuration(this.timings.stageStart, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Staged ${event.componentCount} components ${chalk.gray(`(${duration})`)}`,
      );
    } else if (!this.isOrchestrating()) {
      this.stopSpinner(
        true,
        chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`),
      );
    }
  }

  private handleStageStart(event: StageStartEvent): void {
    this.timings.stageStart = event.timestamp;

    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Staging...`,
      );
    } else if (!this.isOrchestrating()) {
      this.startSpinner('Staging package');
    }
  }

  private handleTaskComplete(event: TaskCompleteEvent): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const status = event.success ? chalk.green('✓') : chalk.red('✗');
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${status} ${event.taskName}`,
      );
    } else if (!this.isOrchestrating()) {
      if (event.success) {
        this.stopSpinner(true, chalk.gray(event.taskName));
      } else {
        this.stopSpinner(false, chalk.red(`${event.taskName} failed`));
      }
    }
  }

  private handleTaskSkipped(event: TaskSkippedEvent): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${chalk.yellow('○')} ${event.taskName} skipped`,
      );
    } else if (!this.isOrchestrating()) {
      this.stopSpinner(true, chalk.yellow(`${event.taskName} skipped: ${event.reason}`));
    }
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  private handleTaskStart(event: TaskStartEvent): void {
    if (!this.isInteractive()) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - ${event.taskType}: ${event.taskName}`,
      );
    } else if (!this.isOrchestrating()) {
      this.startSpinner(`  ${chalk.cyan(event.taskType)}: ${event.taskName}`);
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
