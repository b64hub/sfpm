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
  PendingValidationDescriptor,
  StageCompleteEvent,
  StageStartEvent,
  TaskCompleteEvent,
  TaskSkippedEvent,
  TaskStartEvent,
  ValidationQueuedEvent,
} from '@b64hub/sfpm-core';

import chalk from 'chalk';

import type {
  EventConfig, EventLog, OutputLogger, OutputMode,
} from './renderer-utils.js';
import type {DisplayStrategy} from './strategies/display-strategy.js';

import {calculateDuration, formatDuration, sym} from './renderer-utils.js';
import {createDisplayStrategy} from './strategies/index.js';

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
 * Renders build progress by translating build/orchestration events
 * into display strategy calls.
 *
 * The renderer owns event-to-semantic translation. The display strategy
 * (interactive, plain, silent) owns how that is rendered.
 */
export class BuildProgressRenderer {
  private buildResult?: {
    error?: Error;
    packageVersionId?: string;
    success: boolean;
  };
  private readonly display: DisplayStrategy;
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
  private timings: TimingInfo = {};

  constructor(options: {logger: OutputLogger; mode: OutputMode}) {
    this.display = createDisplayStrategy(options.mode, options.logger);
  }

  /**
   * Attach this renderer to typed event buses.
   */
  public attachTo(buildBus: BuildEventBus, orchestrationBus?: OrchestrationEventBus<PendingValidationDescriptor>): void {
    for (const [eventName, config] of Object.entries(this.eventConfigs)) {
      buildBus.on(eventName as any, (data: any) => {
        this.logEvent(eventName, data);
        config.handler(data);
      });
    }

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
    this.display.error(error);
  }

  // ========================================================================
  // Build Event Handlers
  // ========================================================================

  private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
    const progress = this.runningAnalyzers.get(event.packageName);
    if (progress) {
      progress.completed.push(event.analyzerName);
      const remaining = progress.total.filter(n => !progress.completed.includes(n));
      const label = remaining.length > 0
        ? `analyzing — ${remaining.join(', ')}`
        : 'analyzing...';
      this.display.subtaskUpdate(event.packageName, 'build', label);
    }
  }

  private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
    if (event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.analyzersStart, event.timestamp);
    const analyzerText = event.completedCount === 1 ? 'analyzer' : 'analyzers';
    this.display.subtaskUpdate(event.packageName, 'build', `analyzed (${event.completedCount} ${analyzerText}) ${chalk.gray(`(${duration})`)}`);
    this.runningAnalyzers.delete(event.packageName);
  }

  private handleAnalyzersStart(event: AnalyzersStartEvent): void {
    this.timings.analyzersStart = event.timestamp;
    if (event.analyzerCount === 0) return;

    this.runningAnalyzers.set(event.packageName, {completed: [], total: []});
    this.display.subtaskUpdate(event.packageName, 'build', 'analyzing...');
  }

  private handleAnalyzerStart(event: AnalyzerStartEvent): void {
    const progress = this.runningAnalyzers.get(event.packageName);
    if (progress) {
      progress.total.push(event.analyzerName);
      const names = progress.total.filter(n => !progress.completed.includes(n));
      this.display.subtaskUpdate(event.packageName, 'build', `analyzing — ${names.join(', ')}`);
    }
  }

  private handleBuildComplete(event: BuildCompleteEvent): void {
    this.buildResult = {
      packageVersionId: event.packageVersionId,
      success: true,
    };

    if (event.version) this.packageVersions.set(event.packageName, event.version);

    const version = event.version ? ` @ ${event.version}` : '';
    this.display.subtaskUpdate(event.packageName, 'build', `artifact${chalk.dim(version)}`);
  }

  private handleBuilderComplete(_event: BuilderCompleteEvent): void {
    // No UI update needed — subsequent events handle display
  }

  private handleBuildError(event: BuildErrorEvent): void {
    this.buildResult = {
      error: event.error,
      success: false,
    };

    this.display.subtaskUpdate(event.packageName, 'build', `${chalk.red('failed')} in ${event.phase}`);
    this.display.packageFail(event.packageName, `Build failed in ${event.phase}: ${event.error.message}`);
  }

  private handleBuilderStart(event: BuilderStartEvent): void {
    this.timings.builderStart = event.timestamp;
    this.display.subtaskUpdate(event.packageName, 'build', `executing ${event.packageType} builder...`);
  }

  private handleBuildSkipped(event: BuildSkippedEvent): void {
    this.buildResult = {success: true};

    const reasonLabels: Record<string, string> = {
      'empty-package': 'package contains no deployable components',
      'no-changes': 'no source changes detected',
    };
    const reasonLabel = reasonLabels[event.reason] ?? event.reason;

    this.skippedReasons.set(event.packageName, reasonLabel);
    this.display.subtaskUpdate(event.packageName, 'build', chalk.dim(reasonLabel));
    this.display.packageSkip(event.packageName, reasonLabel);
  }

  private handleBuildStart(event: BuildStartEvent): void {
    this.timings.buildStart = event.timestamp;
    this.display.packageStart(event.packageName);
    this.display.subtaskStart(event.packageName, `building (${event.packageType})`);
  }

  private handleConnectionComplete(event: ConnectionCompleteEvent): void {
    const duration = calculateDuration(this.timings.connectionStart, event.timestamp);
    this.display.subtaskUpdate(event.packageName, 'build', `connected to ${chalk.yellow(event.username)} ${chalk.gray(`(${duration})`)}`);
  }

  private handleConnectionStart(event: ConnectionStartEvent): void {
    this.timings.connectionStart = event.timestamp;
    this.display.subtaskStart(event.packageName, `connecting to ${event.orgType}: ${chalk.yellow(event.username)}`);
  }

  private handleCreateComplete(event: CreateCompleteEvent): void {
    const elapsed = this.timings.createStart
      ? formatDuration(Date.now() - this.timings.createStart.getTime())
      : '';
    const elapsedSuffix = elapsed ? chalk.dim(` (${elapsed})`) : '';

    this.display.subtaskUpdate(event.packageName, 'build', `created ${event.versionNumber}${elapsedSuffix}`);
  }

  private handleCreateProgress(event: CreateProgressEvent): void {
    if (!event.message) return;

    const elapsed = this.timings.createStart
      ? formatDuration(Date.now() - this.timings.createStart.getTime())
      : '';
    const elapsedSuffix = elapsed ? chalk.dim(` (${elapsed})`) : '';

    this.display.subtaskUpdate(event.packageName, 'build', `creating: ${event.message}${elapsedSuffix}`);
  }

  private handleCreateStart(event: CreateStartEvent): void {
    this.timings.createStart = event.timestamp;
    this.display.subtaskUpdate(event.packageName, 'build', `creating version ${event.versionNumber}...`);
  }

  private handleHookComplete(event: HookCompleteEvent): void {
    const progress = this.hookProgress.get(event.packageName);
    if (progress) {
      progress.completed.push(event.hookName);
    }
  }

  private handleHooksComplete(event: HooksCompleteEvent): void {
    if (event.completedCount === 0) return;

    const duration = calculateDuration(this.timings.hooksStart, event.timestamp);
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
  // Orchestration Event Handlers
  // ========================================================================

  private handleOrchestrationComplete(event: OrchestrationCompleteEvent<PendingValidationDescriptor>): void {
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

  private handleOrchestrationPackageComplete(event: OrchestrationPackageCompleteEvent): void {
    this.logEvent('orchestration:package:complete', event);

    const duration = formatDuration(event.duration);

    if (event.skipped) {
      const reason = this.skippedReasons.get(event.packageName);
      this.display.packageSkip(event.packageName, reason ?? 'skipped');
    } else if (event.success) {
      const version = this.packageVersions.get(event.packageName);
      const versionSuffix = version ? ` @ ${version}` : '';
      this.display.packageComplete(event.packageName, `${formatDuration(event.duration)}${chalk.dim(versionSuffix)}`);
    } else {
      this.display.packageFail(event.packageName, event.error || 'Build failed');
    }
  }

  private handleOrchestrationStart(event: OrchestrationStartEvent): void {
    this.logEvent('orchestration:start', event);

    const levelText = event.totalLevels === 1 ? 'level' : 'levels';
    const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
    let title = `Building ${chalk.cyan(String(event.totalPackages))} ${pkgText} across ${chalk.cyan(String(event.totalLevels))} ${levelText}`;

    if (event.includeDependencies) {
      title += chalk.dim('\n  Dependencies auto-included');
    }

    this.display.start(title, event.packageNames, event.levels);
  }

  private handleStageComplete(event: StageCompleteEvent): void {
    const duration = calculateDuration(this.timings.stageStart, event.timestamp);
    this.display.subtaskUpdate(event.packageName, 'build', `staged ${event.componentCount} components ${chalk.gray(`(${duration})`)}`);
  }

  private handleStageStart(event: StageStartEvent): void {
    this.timings.stageStart = event.timestamp;
    this.display.subtaskStart(event.packageName, 'staging');
  }

  private handleTaskComplete(event: TaskCompleteEvent): void {
    const status = event.success ? sym.success : sym.fail;
    this.display.subtaskUpdate(event.packageName, 'build', `${status} ${event.taskName}`);
  }

  private handleTaskSkipped(event: TaskSkippedEvent): void {
    this.display.subtaskUpdate(event.packageName, 'build', `${sym.skip} ${event.taskName} skipped`);
  }

  private handleTaskStart(event: TaskStartEvent): void {
    this.display.subtaskUpdate(event.packageName, 'build', `${event.taskType}: ${event.taskName}`);
  }

  private handleValidationQueued(event: ValidationQueuedEvent): void {
    this.display.subtaskStart(event.packageName, 'validation');
  }

  // ========================================================================
  // Utility Methods
  // ========================================================================

  private logEvent(type: string, data: any): void {
    this.events.push({data, timestamp: data.timestamp ?? new Date(), type});
  }
}
