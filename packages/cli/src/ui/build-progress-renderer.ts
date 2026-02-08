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

import {ux} from '@oclif/core';
import boxen from 'boxen';
import chalk from 'chalk';
import ora, {Ora} from 'ora';

import {infoBox, successBox, warningBox} from './boxes.js';

/**
 * Output modes for build progress rendering
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
  analyzersStart?: Date;
  analyzerStarts: Map<string, Date>;
  builderStart?: Date;
  buildStart?: Date;
  connectionStart?: Date;
  stageStart?: Date;
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
 * Renders build progress in different output modes
 */
export class BuildProgressRenderer {
  private analyzerNames: string[] = [];
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
  private logger: OutputLogger;
  private maxAnalyzerNameLength: number = 0;
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
  private timings: TimingInfo = {
    analyzerStarts: new Map(),
  };

  constructor(options: {logger: OutputLogger; mode: OutputMode}) {
    this.logger = options.logger;
    this.mode = options.mode;
  }

  /**
   * Attach this renderer to a PackageBuilder or BuildOrchestrator instance
   */
  public attachTo(emitter: BuildOrchestrator | PackageBuilder): void {
    // Attach all configured build event handlers
    for (const [eventName, config] of Object.entries(this.eventConfigs)) {
      (emitter as any).on(eventName, config.handler);
    }

    // Attach orchestration event handlers (no-ops if emitter is a plain PackageBuilder)
    for (const [eventName, config] of Object.entries(this.orchestrationEventConfigs)) {
      (emitter as any).on(eventName, config.handler);
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

  private calculateDuration(start: Date | undefined, end: Date): string {
    if (!start) return '';
    return this.formatDuration(end.getTime() - start.getTime());
  }

  // ========================================================================
  // Event Handlers
  // ========================================================================

  private formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1000);
    return `${minutes}m ${seconds}s`;
  }

  private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
    this.logEvent('analyzer:complete', event);

    if (!this.isInteractive()) return;

    const startTime = this.timings.analyzerStarts.get(event.analyzerName);
    const duration = this.calculateDuration(startTime, event.timestamp);

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
    const paddedDuration = duration.padStart(6); // Pad duration to 6 chars (e.g., "  31ms")
    const paddedName = event.analyzerName.padEnd(this.maxAnalyzerNameLength);

    // Log completion with aligned duration and analyzer name
    console.log(`  ${chalk.green('✓')} ${chalk.gray(paddedDuration)} - ${chalk.cyan(paddedName)}${chalk.gray(findingsSummary)}`);
  }

  private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
    this.logEvent('analyzers:complete', event);

    if (!this.isInteractive() || event.completedCount === 0) return;

    // Show completion summary
    const duration = this.calculateDuration(this.timings.analyzersStart, event.timestamp);
    const analyzerText = event.completedCount === 1 ? 'analyzer' : 'analyzers';
    this.logger.log(chalk.green(`✔ Completed ${event.completedCount} ${analyzerText} in ${duration}`));
    this.logger.log('');

    // Reset analyzer tracking for next build
    this.analyzerNames = [];
    this.maxAnalyzerNameLength = 0;
  }

  private handleAnalyzersStart(event: AnalyzersStartEvent): void {
    this.logEvent('analyzers:start', event);
    this.timings.analyzersStart = event.timestamp;

    if (!this.isInteractive() || event.analyzerCount === 0) return;

    // Log a static message instead of spinner for parallel analyzers
    const analyzerText = event.analyzerCount === 1 ? 'analyzer' : 'analyzers';
    this.logger.log(chalk.dim(`Running ${event.analyzerCount} ${analyzerText}...`));
  }

  private handleAnalyzerStart(event: AnalyzerStartEvent): void {
    this.logEvent('analyzer:start', event);
    this.timings.analyzerStarts.set(event.analyzerName, event.timestamp);

    // Track analyzer names for alignment
    if (!this.analyzerNames.includes(event.analyzerName)) {
      this.analyzerNames.push(event.analyzerName);
      this.maxAnalyzerNameLength = Math.max(
        this.maxAnalyzerNameLength,
        event.analyzerName.length,
      );
    }
  }

  private handleBuildComplete(event: BuildCompleteEvent): void {
    this.logEvent('build:complete', event);
    this.buildResult = {
      packageVersionId: event.packageVersionId,
      success: true,
    };

    if (!this.isInteractive()) return;

    const duration = this.calculateDuration(this.timings.buildStart, event.timestamp);
    this.logger.log(chalk.green.bold('\n✓ Build complete!') + chalk.gray(` (${duration})`));
  }

  private handleBuilderComplete(event: BuilderCompleteEvent): void {
    this.logEvent('builder:complete', event);
  }

  private handleBuildError(event: BuildErrorEvent): void {
    this.logEvent('build:error', event);
    this.buildResult = {
      error: event.error,
      success: false,
    };

    // Stop any active spinner
    if (this.isInteractive()) {
      this.stopSpinner(false);
    }

    // Always show errors, even in quiet mode
    this.logger.error(chalk.red.bold(`✗ Build failed in ${event.phase} phase: `) + event.error.message);
  }

  private handleBuilderStart(event: BuilderStartEvent): void {
    this.logEvent('builder:start', event);
    this.timings.builderStart = event.timestamp;

    if (!this.isInteractive()) return;

    this.logger.log(chalk.dim(`Executing ${event.packageType} package builder...\n`));
  }

  private handleBuildSkipped(event: BuildSkippedEvent): void {
    this.logEvent('build:skipped', event);
    this.buildResult = {
      success: true,
    };

    if (!this.isInteractive()) return;

    const duration = this.calculateDuration(this.timings.buildStart, event.timestamp);

    // Build the info box
    const entries: Array<[string, string]> = [
      ['Status', chalk.yellow('No source changes detected')],
      ['Latest version', event.latestVersion],
      ['Source hash', event.sourceHash],
    ];

    if (event.artifactPath) {
      entries.push(['Artifact', event.artifactPath]);
    }

    const maxKeyLength = Math.max(...entries.map(([key]) => key.length));
    const formattedLines = entries.map(([key, value]) => {
      const paddedKey = key.padEnd(maxKeyLength);
      return `${chalk.cyan(paddedKey)} │ ${value}`;
    });

    const boxOutput = boxen(formattedLines.join('\n'), {
      borderColor: 'yellow',
      borderStyle: 'round',
      margin: 0,
      padding: 1,
      title: 'Build Skipped',
      titleAlignment: 'center',
    });

    this.logger.log('');
    this.logger.log(boxOutput);
    this.logger.log('');
    this.logger.log(chalk.dim(`  Build skipped in ${duration}\n`));
  }

  private handleBuildStart(event: BuildStartEvent): void {
    this.logEvent('build:start', event);
    this.timings.buildStart = event.timestamp;

    if (!this.isInteractive()) return;

    this.logger.log(chalk.bold(`\nBuilding package: ${chalk.cyan(event.packageName)} (${event.packageType})\n`));
  }

  private handleConnectionComplete(event: ConnectionCompleteEvent): void {
    this.logEvent('connection:complete', event);

    if (!this.isInteractive()) return;

    const duration = this.calculateDuration(this.timings.connectionStart, event.timestamp);
    this.stopSpinner(true, chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
  }

  private handleConnectionStart(event: ConnectionStartEvent): void {
    this.logEvent('connection:start', event);
    this.timings.connectionStart = event.timestamp;

    if (!this.isInteractive()) return;

    this.startSpinner(`Connecting to ${event.orgType}: ${event.username}`);
  }

  private handleCreateComplete(event: CreateCompleteEvent): void {
    this.logEvent('unlocked:create:complete', event);

    if (this.isInteractive()) {
      this.stopSpinner(true, chalk.green(`Package ${event.packageName}@${event.versionNumber} successfully created with Id: ${event.packageVersionId}`));

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
    this.logEvent('unlocked:create:progress', event);

    if (!this.isInteractive() || !event.message) return;

    if (this.spinner) {
      this.spinner.text = `Creating package version ${event.packageName}@${event.message}`;
    }
  }

  private handleCreateStart(event: CreateStartEvent): void {
    this.logEvent('unlocked:create:start', event);

    if (!this.isInteractive()) return;

    this.startSpinner(`Creating package version ${event.packageName}@${event.versionNumber}`);
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
    const title = allSucceeded ? 'Build Orchestration Complete' : 'Build Orchestration Complete (with failures)';

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
      text: `Building ${chalk.cyan(String(event.packages.length))} ${pkgText}`,
    }).start();
  }

  // ========================================================================
  // Orchestration Event Handlers
  // ========================================================================

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

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    if (!this.isInteractive()) return;

    const levelText = event.totalLevels === 1 ? 'level' : 'levels';
    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    this.logger.log(chalk.bold(`\nBuilding ${chalk.cyan(String(event.totalPackages))} ${pkgText} in ${chalk.cyan(String(event.totalLevels))} ${levelText}\n`));

    if (event.includeDependencies) {
      this.logger.log(chalk.dim('  Dependencies auto-included\n'));
    }
  }

  private handleStageComplete(event: StageCompleteEvent): void {
    this.logEvent('stage:complete', event);

    if (!this.isInteractive()) return;

    const duration = this.calculateDuration(this.timings.stageStart, event.timestamp);
    this.stopSpinner(
      true,
      chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`),
    );
  }

  private handleStageStart(event: StageStartEvent): void {
    this.logEvent('stage:start', event);
    this.timings.stageStart = event.timestamp;

    if (!this.isInteractive()) return;

    this.startSpinner('Staging package');
  }

  private handleTaskComplete(event: TaskCompleteEvent): void {
    this.logEvent('task:complete', event);

    if (!this.isInteractive()) return;

    if (event.success) {
      this.stopSpinner(true, chalk.gray(event.taskName));
    } else {
      this.stopSpinner(false, chalk.red(`${event.taskName} failed`));
    }
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  private handleTaskStart(event: TaskStartEvent): void {
    this.logEvent('task:start', event);

    if (!this.isInteractive()) return;

    this.startSpinner(`  ${chalk.cyan(event.taskType)}: ${event.taskName}`);
  }

  /**
   * Check if renderer is in interactive mode
   */
  private isInteractive(): boolean {
    return this.mode === 'interactive';
  }

  private logEvent(type: string, data: any): void {
    this.events.push({data, timestamp: data.timestamp, type});
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
