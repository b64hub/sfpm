import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import { ux } from '@oclif/core';
import type { PackageBuilder } from '@b64/sfpm-core';
import type {
    BuildStartEvent,
    BuildCompleteEvent,
    BuildSkippedEvent,
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
import { infoBox } from './boxes.js';

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
    private analyzerNames: string[] = [];
    private maxAnalyzerNameLength: number = 0;
    
    /**
     * Event configuration mapping events to handlers
     */
    private eventConfigs: Record<string, EventConfig> = {
        'build:start': { handler: this.handleBuildStart.bind(this), description: 'Build started' },
        'build:complete': { handler: this.handleBuildComplete.bind(this), description: 'Build completed' },
        'build:skipped': { handler: this.handleBuildSkipped.bind(this), description: 'Build skipped' },
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
            padding: 1,
            margin: 0,
            borderStyle: 'round',
            borderColor: 'yellow',
            title: 'Build Skipped',
            titleAlignment: 'center',
        });

        this.logger.log('');
        this.logger.log(boxOutput);
        this.logger.log('');
        this.logger.log(chalk.dim(`  Build skipped in ${duration}\n`));
    }

    private handleBuildError(event: BuildErrorEvent): void {
        this.logEvent('build:error', event);
        this.buildResult = {
            success: false,
            error: event.error,
        };

        // Stop any active spinner
        if (this.isInteractive()) {
            this.stopSpinner(false);
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

        this.startSpinner(`Staging package`);
    }

    private handleStageComplete(event: StageCompleteEvent): void {
        this.logEvent('stage:complete', event);

        if (!this.isInteractive()) return;

        const duration = this.calculateDuration(this.timings.stageStart, event.timestamp);
        this.stopSpinner(
            true,
            chalk.gray(`Successfully staged ${event.packageName} with ${event.componentCount} component(s) (${duration})`)
        );
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
                event.analyzerName.length
            );
        }
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

    private handleConnectionStart(event: ConnectionStartEvent): void {
        this.logEvent('connection:start', event);
        this.timings.connectionStart = event.timestamp;

        if (!this.isInteractive()) return;

        this.startSpinner(`Connecting to ${event.orgType}: ${event.username}`);
    }

    private handleConnectionComplete(event: ConnectionCompleteEvent): void {
        this.logEvent('connection:complete', event);

        if (!this.isInteractive()) return;

        const duration = this.calculateDuration(this.timings.connectionStart, event.timestamp);
        this.stopSpinner(true, chalk.gray(`Successfully connected to: ${event.username} (${duration})`));
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

        this.startSpinner(`Creating package version ${event.packageName}@${event.versionNumber}`);
    }

    private handleCreateProgress(event: CreateProgressEvent): void {
        this.logEvent('unlocked:create:progress', event);

        if (!this.isInteractive() || !event.message) return;

        if (this.spinner) {
            this.spinner.text = `Creating package version ${event.packageName}@${event.message}`;
        }
    }

    private handleCreateComplete(event: CreateCompleteEvent): void {
        this.logEvent('unlocked:create:complete', event);

        if (this.isInteractive()) {
            this.stopSpinner(true, chalk.green(`Package ${event.packageName}@${event.versionNumber} successfully created with Id: ${event.packageVersionId}`));

            // Build package details entries
            const entries: Record<string, string> = {   
                'Package Name': event.packageName,
                'Version Number': event.versionNumber,
                'Version ID': event.packageVersionId,
            };
            
            if (event.packageId) {
                entries['Package ID'] = event.packageId;
            }
            if (event.status) {
                entries['Status'] = event.status;
            }
            if (event.totalNumberOfMetadataFiles !== undefined) {
                entries['Metadata Files'] = String(event.totalNumberOfMetadataFiles);
            }
            if (event.codeCoverage !== null && event.codeCoverage !== undefined) {
                const coverageColor = event.hasPassedCodeCoverageCheck ? chalk.green : chalk.yellow;
                entries['Code Coverage'] = coverageColor(`${event.codeCoverage}%`);
            }
            if (event.createdDate) {
                entries['Created'] = event.createdDate;
            }

            // Display the box
            this.logger.log('');
            this.logger.log(infoBox('Package Version Details', entries));
            this.logger.log('');
        }
    }

    private handleTaskStart(event: TaskStartEvent): void {
        this.logEvent('task:start', event);

        if (!this.isInteractive()) return;

        this.startSpinner(`  ${chalk.cyan(event.taskType)}: ${event.taskName}`);
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

        this.stopSpinner(false);
    }
}
