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
  OrchestrationCompleteEvent,
  OrchestrationLevelCompleteEvent,
  OrchestrationLevelStartEvent,
  OrchestrationPackageCompleteEvent,
  OrchestrationStartEvent,
  PackageBuilder,
  StageCompleteEvent,
  StageStartEvent,
  TaskCompleteEvent,
  TaskStartEvent,
} from '@b64/sfpm-core';

import chalk from 'chalk';
import ora, {Ora} from 'ora';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';

import {infoBox, successBox, warningBox} from './boxes.js';
import {OrchestrationListrManager} from './orchestration-listr.js';
import {calculateDuration, formatDuration, NameAligner} from './renderer-utils.js';

export type {OutputMode} from './renderer-utils.js';

/**
 * Timing information tracked internally
 */
interface TimingInfo {
  analyzersStart?: Date;
  analyzerStarts: Map<string, Date>;
  builderStart?: Date;
  buildStart?: Date;
  connectionStart?: Date;
  createStart?: Date;
  stageStart?: Date;
}

/**
 * Renders build progress in different output modes
 */
export class BuildProgressRenderer {
  private analyzerNameAligner = new NameAligner();
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
    'stage:complete': {description: 'Staging complete', handler: this.handleStageComplete.bind(this)},
    'stage:start': {description: 'Staging package', handler: this.handleStageStart.bind(this)},
    'task:complete': {description: 'Task complete', handler: this.handleTaskComplete.bind(this)},
    'task:start': {description: 'Task started', handler: this.handleTaskStart.bind(this)},
    'unlocked:create:complete': {description: 'Package creation complete', handler: this.handleCreateComplete.bind(this)},
    'unlocked:create:progress': {description: 'Package creation progress', handler: this.handleCreateProgress.bind(this)},
    'unlocked:create:start': {description: 'Package creation started', handler: this.handleCreateStart.bind(this)},
  };
  private events: EventLog[] = [];
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
   * Tracks pending analyzer names during collection.
   * Once all `analyzer:start` events arrive, subtasks are created.
   */
  private pendingAnalyzers: Map<string, {count: number; names: string[]}> = new Map();
  /**
   * Tracks skip reasons per package so they survive across event handlers.
   * Populated by `build:skipped`, consumed by `orchestration:package:complete`.
   */
  private skippedReasons: Map<string, string> = new Map();
  private spinner?: Ora;
  private timings: TimingInfo = {
    analyzerStarts: new Map(),
  };

  constructor(options: {logger: OutputLogger; mode: OutputMode}) {
    this.logger = options.logger;
    this.mode = options.mode;
    this.listr = new OrchestrationListrManager(event => {
      const count = event.packages.length;
      const pkgText = count === 1 ? 'package' : 'packages';
      return `Building ${chalk.cyan(String(count))} ${pkgText}`;
    }, {enableSubtasks: true});
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

    const startTime = this.timings.analyzerStarts.get(event.analyzerName);
    const duration = calculateDuration(startTime, event.timestamp);

    const task = this.getPackageTask(event.packageName);
    if (task) {
      if (this.listr.hasSubtasks(event.packageName)) {
        // Build findings suffix for the subtask title
        let findingsSuffix = '';
        if (event.findings && Object.keys(event.findings).length > 0) {
          const findings = Object.entries(event.findings)
          .filter(([_, value]) => value && (Array.isArray(value) ? value.length > 0 : true))
          .map(([key, value]) => (Array.isArray(value) ? `${key}: ${value.length}` : key))
          .join(', ');
          if (findings) findingsSuffix = ` ${chalk.gray(`- ${findings}`)}`;
        }

        this.listr.updateSubtaskTitle(
          event.packageName,
          event.analyzerName,
          `${chalk.green(event.analyzerName)} ${chalk.gray(`(${duration})`)}${findingsSuffix}`,
        );
        this.listr.resolveSubtask(event.packageName, event.analyzerName);
      } else {
        this.listr.updatePackageTitle(
          event.packageName,
          `${chalk.cyan(event.packageName)} - Analyzer: ${event.analyzerName} ${chalk.gray(`(${duration})`)}`,
        );
      }
    } else if (!this.isOrchestrating()) {
      // Build findings summary
      let findingsSummary = '';
      if (event.findings && Object.keys(event.findings).length > 0) {
        const findings = Object.entries(event.findings)
        .filter(([_, value]) => value && (Array.isArray(value) ? value.length > 0 : true))
        .map(([key, value]) => {
          if (Array.isArray(value)) {
            return `${key}: ${value.length}`;
          }

          return key;
        })
        .join(', ');

        if (findings) {
          findingsSummary = `: ${findings}`;
        }
      }

      // Pad duration and analyzer name for alignment
      const paddedDuration = duration.padStart(6);
      const paddedName = this.analyzerNameAligner.pad(event.analyzerName);

      // Log completion with aligned duration and analyzer name
      console.log(`  ${chalk.green('✓')} ${chalk.gray(paddedDuration)} - ${chalk.cyan(paddedName)}${chalk.gray(findingsSummary)}`);
    }
  }

  private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
    if (!this.isInteractive() || event.completedCount === 0) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      // With subtasks the individual analyzer tasks already show completion;
      // only update the parent title when NOT using subtask mode.
      if (!this.listr.hasSubtasks(event.packageName)) {
        this.listr.updatePackageTitle(
          event.packageName,
          `${chalk.cyan(event.packageName)} - Analyzed (${event.completedCount} analyzers)`,
        );
      }
    } else if (!this.isOrchestrating()) {
      // Show completion summary
      const duration = calculateDuration(this.timings.analyzersStart, event.timestamp);
      const analyzerText = event.completedCount === 1 ? 'analyzer' : 'analyzers';
      this.logger.log(chalk.green(`✔ Completed ${event.completedCount} ${analyzerText} in ${duration}`));
      this.logger.log('');
    }

    // Reset analyzer tracking for next build
    this.analyzerNameAligner.reset();
  }

  private handleAnalyzersStart(event: AnalyzersStartEvent): void {
    this.timings.analyzersStart = event.timestamp;

    if (!this.isInteractive()) return;

    // In orchestration mode, set up subtask collection or skip
    if (this.isOrchestrating()) {
      if (event.analyzerCount === 0) {
        this.listr.skipPackageSubtasks(event.packageName);
      } else {
        this.pendingAnalyzers.set(event.packageName, {count: event.analyzerCount, names: []});
      }
    }

    if (event.analyzerCount === 0) return;

    const task = this.getPackageTask(event.packageName);
    if (task) {
      const analyzerText = event.analyzerCount === 1 ? 'analyzer' : 'analyzers';
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Running ${event.analyzerCount} ${analyzerText}...`,
      );
    } else if (!this.isOrchestrating()) {
      // Log a static message instead of spinner for parallel analyzers
      const analyzerText = event.analyzerCount === 1 ? 'analyzer' : 'analyzers';
      this.logger.log(chalk.dim(`Running ${event.analyzerCount} ${analyzerText}...`));
    }
  }

  private handleAnalyzerStart(event: AnalyzerStartEvent): void {
    this.timings.analyzerStarts.set(event.analyzerName, event.timestamp);

    // Track analyzer names for alignment
    this.analyzerNameAligner.add(event.analyzerName);

    // In orchestration mode, collect names then create subtasks
    if (this.isOrchestrating()) {
      const pending = this.pendingAnalyzers.get(event.packageName);
      if (pending) {
        pending.names.push(event.analyzerName);
        if (pending.names.length === pending.count) {
          // All analyzer names collected — declare subtask structure
          this.listr.setPackageSubtasks(
            event.packageName,
            pending.names.map(name => ({name, title: chalk.cyan(name)})),
          );
          this.pendingAnalyzers.delete(event.packageName);
        }
      }
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

    // If subtasks haven't been set for this package yet (e.g. Data packages
    // that skip analyzers entirely), resolve with empty subtasks now.
    if (this.isOrchestrating()) {
      this.listr.skipPackageSubtasks(event.packageName);
    }

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

    const reasonLabel = event.reason === 'no-changes'
      ? 'no source changes detected'
      : event.reason;

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

      entries['Latest Build'] = event.latestVersion;
      entries['Source Hash'] = chalk.dim(event.sourceHash);

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
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Created ${event.versionNumber}${elapsedSuffix}`,
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
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Creating: ${event.message}${elapsedSuffix}`,
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
      this.listr.updatePackageTitle(
        event.packageName,
        `${chalk.cyan(event.packageName)} - Creating version ${event.versionNumber}...`,
      );
    } else if (!this.isOrchestrating()) {
      this.startSpinner(`Creating package version ${event.packageName}@${event.versionNumber}`);
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
