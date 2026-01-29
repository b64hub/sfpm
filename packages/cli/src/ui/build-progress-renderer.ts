import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import { ux } from '@oclif/core';
import type { PackageBuilder } from '@b64/sfpm-core';
import type {
    BuildStartEvent,
    BuildCompleteEvent,
    BuildErrorEvent,
    StageStartEvent,
    StageCompleteEvent,
    AnalyzersStartEvent,
    AnalyzerStartEvent,
    AnalyzerCompleteEvent,
    AnalyzersCompleteEvent,
    ConnectionStartEvent,
    ConnectionCompleteEvent,
    BuilderStartEvent,
    BuilderCompleteEvent,
    CreateStartEvent,
    CreateProgressEvent,
    CreateCompleteEvent,
    TaskStartEvent,
    TaskCompleteEvent,
} from '@b64/sfpm-core';

/**
 * Output modes for build progress rendering
 */
export type OutputMode = 'interactive' | 'quiet' | 'json';

/**
 * Logger interface for rendering output
 */
interface OutputLogger {
    log: (message: string) => void;
    error: (message: string | Error) => void;
}

/**
 * Collected event data for JSON output
 */
interface EventLog {
    type: string;
    timestamp: Date;
    data: any;
}

/**
 * Timing information tracked internally
 */
interface TimingInfo {
    buildStart?: Date;
    stageStart?: Date;
    analyzersStart?: Date;
    analyzerStarts: Map<string, Date>;
    connectionStart?: Date;
    builderStart?: Date;
}

/**
 * Event handler function type
 */
type EventHandler<T = any> = (event: T) => void;

/**
 * Event configuration for systematic handling
 */
interface EventConfig {
    handler: EventHandler;
    description: string;
}

/**
 * Renders build progress in different output modes
 */
export class BuildProgressRenderer {
    private mode: OutputMode;
    private logger: OutputLogger;
    private spinners: Map<string, Ora> = new Map();
    private events: EventLog[] = [];
    private timings: TimingInfo = {
        analyzerStarts: new Map(),
    };
    private buildResult?: {
        success: boolean;
        packageVersionId?: string;
        error?: Error;
    };
    private currentActions: Set<string> = new Set();
    
    /**
     * Event configuration mapping events to handlers
     */
    private eventConfigs: Record<string, EventConfig> = {
        'build:start': { handler: this.handleBuildStart.bind(this), description: 'Build started' },
        'build:complete': { handler: this.handleBuildComplete.bind(this), description: 'Build completed' },
        'build:error': { handler: this.handleBuildError.bind(this), description: 'Build failed' },
        'stage:start': { handler: this.handleStageStart.bind(this), description: 'Staging package' },
        'stage:complete': { handler: this.handleStageComplete.bind(this), description: 'Staging complete' },
        'analyzers:start': { handler: this.handleAnalyzersStart.bind(this), description: 'Analyzers started' },
        'analyzer:start': { handler: this.handleAnalyzerStart.bind(this), description: 'Analyzer started' },
        'analyzer:complete': { handler: this.handleAnalyzerComplete.bind(this), description: 'Analyzer complete' },
        'analyzers:complete': { handler: this.handleAnalyzersComplete.bind(this), description: 'All analyzers complete' },
        'connection:start': { handler: this.handleConnectionStart.bind(this), description: 'Connection started' },
        'connection:complete': { handler: this.handleConnectionComplete.bind(this), description: 'Connection complete' },
        'builder:start': { handler: this.handleBuilderStart.bind(this), description: 'Builder started' },
        'builder:complete': { handler: this.handleBuilderComplete.bind(this), description: 'Builder complete' },
        'unlocked:create:start': { handler: this.handleCreateStart.bind(this), description: 'Package creation started' },
        'unlocked:create:progress': { handler: this.handleCreateProgress.bind(this), description: 'Package creation progress' },
        'unlocked:create:complete': { handler: this.handleCreateComplete.bind(this), description: 'Package creation complete' },
        'task:start': { handler: this.handleTaskStart.bind(this), description: 'Task started' },
        'task:complete': { handler: this.handleTaskComplete.bind(this), description: 'Task complete' },
    };

    constructor(options: { logger: OutputLogger; mode: OutputMode }) {
        this.logger = options.logger;
        this.mode = options.mode;
    }

    /**
     * Attach this renderer to a PackageBuilder instance
     */
    public attachTo(builder: PackageBuilder): void {
        // Attach all configured event handlers
        Object.entries(this.eventConfigs).forEach(([eventName, config]) => {
            builder.on(eventName as any, config.handler as any);
        });
    }

    // ========================================================================
    // Spinner Management
    // ========================================================================

    /**
     * Get or create a spinner for a given key
     */
    private getSpinner(key: string, text: string): Ora {
        let spinner = this.spinners.get(key);
        if (!spinner) {
            spinner = ora(text).start();
            this.spinners.set(key, spinner);
        }
        return spinner;
    }

    /**
     * Stop and remove a spinner
     */
    private stopSpinner(key: string, success: boolean, text?: string): void {
        const spinner = this.spinners.get(key);
        if (spinner) {
            if (success) {
                spinner.succeed(text);
            } else {
                spinner.fail(text);
            }
            this.spinners.delete(key);
        }
    }

    /**
     * Stop all active spinners
     */
    private stopAllSpinners(success: boolean = false): void {
        this.spinners.forEach((spinner, key) => {
            if (success) {
                spinner.succeed();
            } else {
                spinner.fail();
            }
        });
        this.spinners.clear();
    }

    /**
     * Check if renderer is in interactive mode
     */
    private isInteractive(): boolean {
        return this.mode === 'interactive';
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    private handleBuildStart(event: BuildStartEvent): void {
        this.logEvent('build:start', event);
        this.timings.buildStart = event.timestamp;

        if (!this.isInteractive()) return;

        this.logger.log(
            chalk.bold(`\nBuilding package: ${chalk.cyan(event.packageName)} (${event.packageType})\n`)
        );
    }

    private handleBuildComplete(event: BuildCompleteEvent): void {
        this.logEvent('build:complete', event);
        this.buildResult = {
            success: true,
            packageVersionId: event.packageVersionId,
        };

        if (!this.isInteractive()) return;

        const duration = this.calculateDuration(this.timings.buildStart, event.timestamp);
        this.logger.log(
            chalk.green.bold(`\n✓ Build complete!`) + chalk.gray(` (${duration})`)
        );
    }

    private handleBuildError(event: BuildErrorEvent): void {
        this.logEvent('build:error', event);
        this.buildResult = {
            success: false,
            error: event.error,
        };

        // Stop all active spinners with failure
        if (this.isInteractive()) {
            this.stopAllSpinners(false);
            
            // Show which actions were in progress
            if (this.currentActions.size > 0) {
                const actions = Array.from(this.currentActions).join(', ');
                this.logger.error(chalk.red(`Failed during: ${actions}`));
            }
        }

        // Always show errors, even in quiet mode
        this.logger.error(
            chalk.red.bold(`✗ Build failed in ${event.phase} phase: `) + event.error.message
        );
    }

    private handleStageStart(event: StageStartEvent): void {
        this.logEvent('stage:start', event);
        this.timings.stageStart = event.timestamp;

        if (!this.isInteractive()) return;

        this.currentActions.add('stage');
        this.getSpinner('stage', `Staging package`);
    }

    private handleStageComplete(event: StageCompleteEvent): void {
        this.logEvent('stage:complete', event);

        if (!this.isInteractive()) return;

        const duration = this.calculateDuration(this.timings.stageStart, event.timestamp);
        this.stopSpinner(
            'stage',
            true,
            chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`)
        );
        this.currentActions.delete('stage');
    }

    private handleAnalyzersStart(event: AnalyzersStartEvent): void {
        this.logEvent('analyzers:start', event);
        this.timings.analyzersStart = event.timestamp;

        if (!this.isInteractive() || event.analyzerCount === 0) return;

        this.logger.log(chalk.dim(`Running ${event.analyzerCount} analyzers...`));
    }

    private handleAnalyzerStart(event: AnalyzerStartEvent): void {
        this.logEvent('analyzer:start', event);
        this.timings.analyzerStarts.set(event.analyzerName, event.timestamp);

        if (!this.isInteractive()) return;

        const action = `analyzer:${event.analyzerName}`;
        this.currentActions.add(action);
        this.getSpinner(action, `  Analyzing with ${chalk.cyan(event.analyzerName)}`);
    }

    private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
        this.logEvent('analyzer:complete', event);

        if (!this.isInteractive()) return;

        const action = `analyzer:${event.analyzerName}`;
        const startTime = this.timings.analyzerStarts.get(event.analyzerName);
        const duration = this.calculateDuration(startTime, event.timestamp);
        
        // Show what was found if there are findings
        let message = chalk.gray(duration);
        if (event.findings && Object.keys(event.findings).length > 0) {
            const findingsSummary = Object.entries(event.findings)
                .filter(([_, value]) => value && (Array.isArray(value) ? value.length > 0 : true))
                .map(([key, value]) => {
                    if (Array.isArray(value)) {
                        return `${key}: ${value.length}`;
                    }
                    return key;
                })
                .join(', ');
            
            if (findingsSummary) {
                message = chalk.gray(`${duration} - ${event.analyzerName}: ${findingsSummary}`);
            }
        }
        
        this.stopSpinner(action, true, message);
        this.currentActions.delete(action);
    }

    private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
        this.logEvent('analyzers:complete', event);

        if (!this.isInteractive() || event.completedCount === 0) return;

        const duration = this.calculateDuration(this.timings.analyzersStart, event.timestamp);
        this.logger.log(chalk.dim(`  Completed ${event.completedCount} analyzers (${duration})\n`));
    }

    private handleConnectionStart(event: ConnectionStartEvent): void {
        this.logEvent('connection:start', event);
        this.timings.connectionStart = event.timestamp;

        if (!this.isInteractive()) return;

        this.currentActions.add('connection');
        this.getSpinner('connection', `Connecting to ${event.orgType}: ${event.username}`);
    }

    private handleConnectionComplete(event: ConnectionCompleteEvent): void {
        this.logEvent('connection:complete', event);

        if (!this.isInteractive()) return;

        const duration = this.calculateDuration(this.timings.connectionStart, event.timestamp);
        this.stopSpinner('connection', true, chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
        this.currentActions.delete('connection');
    }

    private handleBuilderStart(event: BuilderStartEvent): void {
        this.logEvent('builder:start', event);
        this.timings.builderStart = event.timestamp;

        if (!this.isInteractive()) return;

        this.logger.log(chalk.dim(`Executing ${event.packageType} package builder...\n`));
    }

    private handleBuilderComplete(event: BuilderCompleteEvent): void {
        this.logEvent('builder:complete', event);
    }

    private handleCreateStart(event: CreateStartEvent): void {
        this.logEvent('unlocked:create:start', event);

        if (!this.isInteractive()) return;

        this.currentActions.add('create');
        this.getSpinner('create', `Creating package version ${event.packageName}@${event.versionNumber}`);
    }

    private handleCreateProgress(event: CreateProgressEvent): void {
        this.logEvent('unlocked:create:progress', event);

        if (!this.isInteractive() || !event.message) return;

        const spinner = this.spinners.get('create');
        if (spinner) {
            spinner.text = `Creating package version ${event.packageName}@${event.message}`;
        }
    }

    private handleCreateComplete(event: CreateCompleteEvent): void {
        this.logEvent('unlocked:create:complete', event);

        if (this.isInteractive()) {
            this.stopSpinner('create', true, chalk.green(`Package ${event.packageName}@${event.versionNumber} successfully created with Id: ${event.packageVersionId}`));
            this.currentActions.delete('create');

            // Build package details entries
            const entries: Array<[string, string]> = [
                ['Package Name', event.packageName],
                ['Version Number', event.versionNumber],
                ['Version ID', event.packageVersionId],
            ];
            
            if (event.packageId) {
                entries.push(['Package ID', event.packageId]);
            }
            if (event.status) {
                entries.push(['Status', event.status]);
            }
            if (event.totalNumberOfMetadataFiles !== undefined) {
                entries.push(['Metadata Files', String(event.totalNumberOfMetadataFiles)]);
            }
            if (event.codeCoverage !== null && event.codeCoverage !== undefined) {
                const coverageColor = event.hasPassedCodeCoverageCheck ? chalk.green : chalk.yellow;
                entries.push(['Code Coverage', coverageColor(`${event.codeCoverage}%`)]);
            }
            if (event.createdDate) {
                entries.push(['Created', event.createdDate]);
            }

            // Find the longest key for alignment
            const maxKeyLength = Math.max(...entries.map(([key]) => key.length));

            // Format as aligned key-value pairs
            const formattedLines = entries.map(([key, value]) => {
                const paddedKey = key.padEnd(maxKeyLength);
                return `${chalk.cyan(paddedKey)} │ ${value}`;
            });

            const tableOutput = boxen(formattedLines.join('\n'), {
                padding: 1,
                margin: 0,
                borderStyle: 'round',
                borderColor: 'cyan',
                title: 'Package Version Created',
                titleAlignment: 'center',
            });

            // Display the box
            this.logger.log('');
            this.logger.log(tableOutput);
            this.logger.log('');
        }
    }

    private handleTaskStart(event: TaskStartEvent): void {
        this.logEvent('task:start', event);

        if (!this.isInteractive()) return;

        const action = `task:${event.taskName}`;
        this.currentActions.add(action);
        this.getSpinner(action, `  ${chalk.cyan(event.taskType)}: ${event.taskName}`);
    }

    private handleTaskComplete(event: TaskCompleteEvent): void {
        this.logEvent('task:complete', event);

        if (!this.isInteractive()) return;

        const action = `task:${event.taskName}`;
        if (event.success) {
            this.stopSpinner(action, true, chalk.gray(event.taskName));
        } else {
            this.stopSpinner(action, false, chalk.red(`${event.taskName} failed`));
        }
        this.currentActions.delete(action);
    }

    // ========================================================================
    // Utility Methods
    // ========================================================================

    private logEvent(type: string, data: any): void {
        this.events.push({ type, timestamp: data.timestamp, data });
    }

    private calculateDuration(start: Date | undefined, end: Date): string {
        if (!start) return '';
        const ms = end.getTime() - start.getTime();
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }

    /**
     * Get JSON output for --json flag
     */
    public getJsonOutput(): any {
        const duration = this.timings.buildStart && this.events.length > 0
            ? this.events[this.events.length - 1].timestamp.getTime() - this.timings.buildStart.getTime()
            : 0;

        return {
            status: this.buildResult?.success ? 'success' : 'error',
            duration,
            events: this.events,
            result: this.buildResult,
        };
    }

    /**
     * Handle error display
     */
    public handleError(error: Error): void {
        if (!this.isInteractive()) return;

        this.stopAllSpinners(false);
    }
}
