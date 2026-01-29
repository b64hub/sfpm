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
 * Renders build progress in different output modes
 */
export class BuildProgressRenderer {
    private mode: OutputMode;
    private logger: OutputLogger;
    private spinner?: Ora;
    private events: EventLog[] = [];
    private timings: TimingInfo = {
        analyzerStarts: new Map(),
    };
    private buildResult?: {
        success: boolean;
        packageVersionId?: string;
        error?: Error;
    };
    private currentAction?: string;

    constructor(options: { logger: OutputLogger; mode: OutputMode }) {
        this.logger = options.logger;
        this.mode = options.mode;
    }

    /**
     * Attach this renderer to a PackageBuilder instance
     */
    public attachTo(builder: PackageBuilder): void {
        // Core build events
        builder.on('build:start', this.handleBuildStart.bind(this) as any);
        builder.on('build:complete', this.handleBuildComplete.bind(this) as any);
        builder.on('build:error', this.handleBuildError.bind(this) as any);

        // Stage events
        builder.on('stage:start', this.handleStageStart.bind(this) as any);
        builder.on('stage:complete', this.handleStageComplete.bind(this) as any);

        // Analyzer events
        builder.on('analyzers:start', this.handleAnalyzersStart.bind(this) as any);
        builder.on('analyzer:start', this.handleAnalyzerStart.bind(this) as any);
        builder.on('analyzer:complete', this.handleAnalyzerComplete.bind(this) as any);
        builder.on('analyzers:complete', this.handleAnalyzersComplete.bind(this) as any);

        // Connection events
        builder.on('connection:start', this.handleConnectionStart.bind(this) as any);
        builder.on('connection:complete', this.handleConnectionComplete.bind(this) as any);

        // Builder events
        builder.on('builder:start', this.handleBuilderStart.bind(this) as any);
        builder.on('builder:complete', this.handleBuilderComplete.bind(this) as any);

        // Unlocked package specific events
        builder.on('unlocked:create:start', this.handleCreateStart.bind(this) as any);
        builder.on('unlocked:create:progress', this.handleCreateProgress.bind(this) as any);
        builder.on('unlocked:create:complete', this.handleCreateComplete.bind(this) as any);

        // Task events
        builder.on('task:start', this.handleTaskStart.bind(this) as any);
        builder.on('task:complete', this.handleTaskComplete.bind(this) as any);
    }

    // ========================================================================
    // Event Handlers
    // ========================================================================

    private handleBuildStart(event: BuildStartEvent): void {
        this.logEvent('build:start', event);
        this.timings.buildStart = event.timestamp;

        if (this.mode === 'interactive') {
            this.logger.log(
                chalk.bold(`\nBuilding package: ${chalk.cyan(event.packageName)} (${event.packageType})\n`)
            );
        }
    }

    private handleBuildComplete(event: BuildCompleteEvent): void {
        this.logEvent('build:complete', event);
        this.buildResult = {
            success: true,
            packageVersionId: event.packageVersionId,
        };

        if (this.mode === 'interactive') {
            const duration = this.calculateDuration(this.timings.buildStart, event.timestamp);
            this.logger.log(
                chalk.green.bold(`\n✓ Build complete!`) + chalk.gray(` (${duration})`)
            );
        }
    }

    private handleBuildError(event: BuildErrorEvent): void {
        this.logEvent('build:error', event);
        this.buildResult = {
            success: false,
            error: event.error,
        };

        // Stop any active spinner with failure and show what was running
        if (this.spinner && this.mode === 'interactive') {
            if (this.currentAction) {
                this.spinner.fail(chalk.red(`failed while: ${this.currentAction}`));
            } else {
                this.spinner.fail(chalk.red('failed'));
            }
            this.spinner = undefined;
            this.currentAction = undefined;
        }

        // Always show errors, even in quiet mode
        const phaseInfo = this.currentAction ? ` (during ${this.currentAction})` : '';
        this.logger.error(
            chalk.red.bold(`✗ Build failed in ${event.phase} phase${phaseInfo}: `) + event.error.message
        );
    }

    private handleStageStart(event: StageStartEvent): void {
        this.logEvent('stage:start', event);
        this.timings.stageStart = event.timestamp;

        if (this.mode === 'interactive') {
            this.currentAction = 'stage';
            this.spinner = ora(`Staging package`).start();
        }
    }

    private handleStageComplete(event: StageCompleteEvent): void {
        this.logEvent('stage:complete', event);

        if (this.mode === 'interactive' && this.spinner) {
            const duration = this.calculateDuration(this.timings.stageStart, event.timestamp);
            this.spinner.succeed(
                chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`)
            );
            this.spinner = undefined;
            this.currentAction = undefined;
        }
    }

    private handleAnalyzersStart(event: AnalyzersStartEvent): void {
        this.logEvent('analyzers:start', event);
        this.timings.analyzersStart = event.timestamp;

        if (this.mode === 'interactive' && event.analyzerCount > 0) {
            this.logger.log(chalk.dim(`Running ${event.analyzerCount} analyzers...`));
        }
    }

    private handleAnalyzerStart(event: AnalyzerStartEvent): void {
        this.logEvent('analyzer:start', event);
        this.timings.analyzerStarts.set(event.analyzerName, event.timestamp);

        if (this.mode === 'interactive') {
            this.currentAction = `analyzer:${event.analyzerName}`;
            this.spinner = ora(`  Analyzing with ${chalk.cyan(event.analyzerName)}`).start();
        }
    }

    private handleAnalyzerComplete(event: AnalyzerCompleteEvent): void {
        this.logEvent('analyzer:complete', event);

        if (this.mode === 'interactive' && this.spinner) {
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
                    message = chalk.gray(`${duration} - ${findingsSummary}`);
                }
            }
            
            this.spinner.succeed(message);
            this.spinner = undefined;
            this.currentAction = undefined;
        }
    }

    private handleAnalyzersComplete(event: AnalyzersCompleteEvent): void {
        this.logEvent('analyzers:complete', event);

        if (this.mode === 'interactive' && event.completedCount > 0) {
            const duration = this.calculateDuration(this.timings.analyzersStart, event.timestamp);
            this.logger.log(chalk.dim(`  Completed ${event.completedCount} analyzers (${duration})\n`));
        }
    }

    private handleConnectionStart(event: ConnectionStartEvent): void {
        this.logEvent('connection:start', event);
        this.timings.connectionStart = event.timestamp;

        if (this.mode === 'interactive') {
            this.currentAction = 'connection';
            this.spinner = ora(`Connecting to ${event.orgType}: ${event.username}`).start();
        }
    }

    private handleConnectionComplete(event: ConnectionCompleteEvent): void {
        this.logEvent('connection:complete', event);

        if (this.mode === 'interactive' && this.spinner) {
            const duration = this.calculateDuration(this.timings.connectionStart, event.timestamp);
            this.spinner.succeed(chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
            this.spinner = undefined;
            this.currentAction = undefined;
        }
    }

    private handleBuilderStart(event: BuilderStartEvent): void {
        this.logEvent('builder:start', event);
        this.timings.builderStart = event.timestamp;

        if (this.mode === 'interactive') {
            this.logger.log(chalk.dim(`Executing ${event.packageType} package builder...\n`));
        }
    }

    private handleBuilderComplete(event: BuilderCompleteEvent): void {
        this.logEvent('builder:complete', event);
    }

    private handleCreateStart(event: CreateStartEvent): void {
        this.logEvent('unlocked:create:start', event);

        if (this.mode === 'interactive') {
            this.currentAction = 'create';
            this.spinner = ora(`Creating package version ${event.packageName}@${event.versionNumber}`).start();
        }
    }

    private handleCreateProgress(event: CreateProgressEvent): void {
        this.logEvent('unlocked:create:progress', event);

        if (this.mode === 'interactive' && this.spinner && event.message) {
            this.spinner.text = `Creating package version ${event.packageName}@${event.message}`;
        }
    }

    private handleCreateComplete(event: CreateCompleteEvent): void {
        this.logEvent('unlocked:create:complete', event);

        if (this.mode === 'interactive' && this.spinner) {
            this.spinner.succeed(chalk.green(`Package ${event.packageName}@${event.versionNumber} successfully created with Id: ${event.packageVersionId}`));
            this.spinner = undefined;
            this.currentAction = undefined;

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

        if (this.mode === 'interactive') {
            this.currentAction = `task:${event.taskName}`;
            this.spinner = ora(`  ${chalk.cyan(event.taskType)}: ${event.taskName}`).start();
        }
    }

    private handleTaskComplete(event: TaskCompleteEvent): void {
        this.logEvent('task:complete', event);

        if (this.mode === 'interactive' && this.spinner) {
            if (event.success) {
                this.spinner.succeed(chalk.gray(event.taskName));
            } else {
                this.spinner.fail(chalk.red(`${event.taskName} failed`));
            }
            this.spinner = undefined;
            this.currentAction = undefined;
        }
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
        if (this.spinner && this.mode === 'interactive') {
            this.spinner.fail(chalk.red('failed'));
            this.spinner = undefined;
        }

        if (this.mode !== 'json') {
            // Error already logged by handleBuildError event
        }
    }
}
