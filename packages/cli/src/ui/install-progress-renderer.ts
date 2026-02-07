import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import { ux } from '@oclif/core';
import type { PackageInstaller, InstallOrchestrator } from '@b64/sfpm-core';
import type {
    OrchestrationStartEvent,
    OrchestrationLevelStartEvent,
    OrchestrationPackageCompleteEvent,
    OrchestrationLevelCompleteEvent,
    OrchestrationCompleteEvent,
} from '@b64/sfpm-core';
import { successBox, warningBox } from './boxes.js';

/**
 * Output modes for install progress rendering
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
    installStart?: Date;
    connectionStart?: Date;
    deploymentStart?: Date;
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
 * Renders install progress in different output modes
 */
export class InstallProgressRenderer {
    private mode: OutputMode;
    private logger: OutputLogger;
    private spinner?: Ora;
    private events: EventLog[] = [];
    private timings: TimingInfo = {};
    private installResult?: {
        success: boolean;
        error?: Error;
    };
    
    /**
     * Event configuration mapping events to handlers
     */
    private eventConfigs: Record<string, EventConfig> = {
        'install:start': { handler: this.handleInstallStart.bind(this), description: 'Install started' },
        'install:complete': { handler: this.handleInstallComplete.bind(this), description: 'Install completed' },
        'install:error': { handler: this.handleInstallError.bind(this), description: 'Install error' },
        'connection:start': { handler: this.handleConnectionStart.bind(this), description: 'Connecting to org' },
        'connection:complete': { handler: this.handleConnectionComplete.bind(this), description: 'Connected to org' },
        'deployment:start': { handler: this.handleDeploymentStart.bind(this), description: 'Deployment started' },
        'deployment:progress': { handler: this.handleDeploymentProgress.bind(this), description: 'Deployment progress' },
        'deployment:complete': { handler: this.handleDeploymentComplete.bind(this), description: 'Deployment completed' },
        'version-install:start': { handler: this.handleVersionInstallStart.bind(this), description: 'Version install started' },
        'version-install:progress': { handler: this.handleVersionInstallProgress.bind(this), description: 'Version install progress' },
        'version-install:complete': { handler: this.handleVersionInstallComplete.bind(this), description: 'Version install completed' },
    };

    /**
     * Event configuration for orchestration-level events
     */
    private orchestrationEventConfigs: Record<string, EventConfig> = {
        'orchestration:start': { handler: this.handleOrchestrationStart.bind(this), description: 'Orchestration started' },
        'orchestration:level:start': { handler: this.handleOrchestrationLevelStart.bind(this), description: 'Level started' },
        'orchestration:package:complete': { handler: this.handleOrchestrationPackageComplete.bind(this), description: 'Package complete' },
        'orchestration:level:complete': { handler: this.handleOrchestrationLevelComplete.bind(this), description: 'Level complete' },
        'orchestration:complete': { handler: this.handleOrchestrationComplete.bind(this), description: 'Orchestration complete' },
    };

    constructor(options: { logger: OutputLogger; mode: OutputMode }) {
        this.logger = options.logger;
        this.mode = options.mode;
    }

    /**
     * Attach renderer to a PackageInstaller or InstallOrchestrator instance
     */
    public attachTo(emitter: PackageInstaller | InstallOrchestrator): void {
        Object.entries(this.eventConfigs).forEach(([event, config]) => {
            (emitter as any).on(event, (data: any) => {
                this.logEvent(event, data);
                config.handler(data);
            });
        });

        // Attach orchestration event handlers (no-ops if emitter is a plain PackageInstaller)
        Object.entries(this.orchestrationEventConfigs).forEach(([event, config]) => {
            (emitter as any).on(event, (data: any) => {
                config.handler(data);
            });
        });
    }

    /**
     * Log an event for JSON output and quiet mode
     */
    private logEvent(type: string, data: any): void {
        this.events.push({
            type,
            timestamp: new Date(),
            data,
        });
    }

    /**
     * Get JSON output with all collected events
     */
    public getJsonOutput(): any {
        return {
            success: this.installResult?.success ?? false,
            error: this.installResult?.error?.message,
            events: this.events,
            timings: {
                total: this.timings.installStart 
                    ? Date.now() - this.timings.installStart.getTime()
                    : undefined,
            },
        };
    }

    /**
     * Check if renderer is in interactive mode
     */
    private isInteractive(): boolean {
        return this.mode === 'interactive';
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

        this.logger.log(
            chalk.bold(`Installing package: ${chalk.cyan(packageDisplay)} (${event.packageType})\n`)
        );

        this.spinner = ora({
            text: `Installing ${chalk.cyan(event.packageName)} to ${chalk.yellow(event.targetOrg)}`,
            color: 'cyan',
        }).start();
    }

    /**
     * Handle install complete event
     */
    private handleInstallComplete(event: any): void {
        this.installResult = { success: true };

        if (!this.isInteractive()) {
            return;
        }

        this.spinner?.succeed(
            chalk.green(`Successfully installed ${chalk.bold(event.packageName)}`)
        );

        const duration = this.timings.installStart 
            ? Date.now() - this.timings.installStart.getTime()
            : 0;

        this.logger.log(successBox('Installation Complete', {
            'Package Name': event.packageName,
            'Version Number': event.versionNumber,
            'Version ID': event.packageVersionId,
            'Target Org': event.targetOrg,
            'Source': event.source,
            'Duration': this.formatDuration(duration),
        }));
    }

    /**
     * Handle install error event
     */
    private handleInstallError(event: any): void {
        this.installResult = {
            success: false,
            error: event.error,
        };

        if (!this.isInteractive()) {
            if (this.mode === 'quiet') {
                this.logger.error(event.error);
            }
            return;
        }

        this.spinner?.fail(
            chalk.red(`Failed to install ${chalk.bold(event.packageName)}`)
        );
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
     * Handle connection complete event
     */
    private handleConnectionComplete(event: any): void {
        if (!this.isInteractive()) {
            return;
        }

        this.spinner?.succeed(
            chalk.green(`Connected to org ${chalk.yellow(event.targetOrg)}`)
        );
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
            text: `Deploying metadata to ${chalk.yellow(event.targetOrg)}...`,
            color: 'cyan',
        }).start();
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
     * Handle deployment complete event
     */
    private handleDeploymentComplete(event: any): void {
        if (!this.isInteractive()) {
            return;
        }

        this.spinner?.succeed(
            chalk.green(`Metadata deployed successfully`)
        );

        if (event.numberComponentsDeployed) {
            this.logger.log(
                chalk.gray(`  Deployed ${event.numberComponentsDeployed} components`)
            );
        }
    }

    /**
     * Handle version install start event
     */
    private handleVersionInstallStart(event: any): void {
        if (!this.isInteractive()) {
            return;
        }

        this.spinner = ora({
            text: `Installing package version ${chalk.cyan(event.packageVersionId)}...`,
            color: 'cyan',
        }).start();
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
     * Handle version install complete event
     */
    private handleVersionInstallComplete(event: any): void {
        if (!this.isInteractive()) {
            return;
        }

        this.spinner?.succeed(
            chalk.green(`Package version installed successfully`)
        );
    }

    /**
     * Handle errors during installation
     */
    public handleError(error: Error): void {
        this.installResult = {
            success: false,
            error,
        };

        if (!this.isInteractive()) {
            if (this.mode === 'quiet') {
                this.logger.error(error);
            }
            return;
        }

        this.spinner?.fail(chalk.red('Installation failed'));

        this.logger.log(
            boxen(
                chalk.white(error.message),
                {
                    padding: 1,
                    margin: { top: 1, bottom: 1 },
                    borderStyle: 'round',
                    borderColor: 'red',
                    title: 'Installation Error',
                    titleAlignment: 'center',
                }
            )
        );
    }

    // ========================================================================
    // Orchestration Event Handlers
    // ========================================================================

    private handleOrchestrationStart(event: OrchestrationStartEvent): void {
        this.logEvent('orchestration:start', event);

        if (!this.isInteractive()) return;

        const levelText = event.totalLevels === 1 ? 'level' : 'levels';
        const pkgText = event.totalPackages === 1 ? 'package' : 'packages';
        this.logger.log(
            chalk.bold(`\nInstalling ${chalk.cyan(String(event.totalPackages))} ${pkgText} in ${chalk.cyan(String(event.totalLevels))} ${levelText}\n`)
        );

        if (event.includeDependencies) {
            this.logger.log(chalk.dim('  Dependencies auto-included\n'));
        }
    }

    private handleOrchestrationLevelStart(event: OrchestrationLevelStartEvent): void {
        this.logEvent('orchestration:level:start', event);

        if (!this.isInteractive()) return;

        const pkgList = event.packages.map((p) => chalk.cyan(p)).join(', ');
        this.logger.log(
            chalk.bold(`--- Level ${event.level + 1} ---`) + chalk.gray(` [${pkgList}]`)
        );
    }

    private handleOrchestrationPackageComplete(event: OrchestrationPackageCompleteEvent): void {
        this.logEvent('orchestration:package:complete', event);

        if (!this.isInteractive()) return;

        const duration = this.formatDuration(event.duration);

        if (event.skipped) {
            this.logger.log(
                `  ${chalk.yellow('⊘')} ${chalk.yellow(event.packageName)} ${chalk.dim('skipped')} ${chalk.gray(`(${duration})`)}`
            );
        } else if (event.success) {
            this.logger.log(
                `  ${chalk.green('✓')} ${chalk.green(event.packageName)} ${chalk.gray(`(${duration})`)}`
            );
        } else {
            this.logger.log(
                `  ${chalk.red('✗')} ${chalk.red(event.packageName)} ${chalk.gray(`(${duration})`)}${event.error ? chalk.red(` - ${event.error}`) : ''}`
            );
        }
    }

    private handleOrchestrationLevelComplete(event: OrchestrationLevelCompleteEvent): void {
        this.logEvent('orchestration:level:complete', event);

        if (!this.isInteractive()) return;

        const parts: string[] = [];
        if (event.succeeded.length > 0) parts.push(chalk.green(`${event.succeeded.length} succeeded`));
        if (event.failed.length > 0) parts.push(chalk.red(`${event.failed.length} failed`));
        if (event.skipped.length > 0) parts.push(chalk.yellow(`${event.skipped.length} skipped`));

        this.logger.log(chalk.dim(`  Level ${event.level + 1} complete: ${parts.join(', ')}\n`));
    }

    private handleOrchestrationComplete(event: OrchestrationCompleteEvent): void {
        this.logEvent('orchestration:complete', event);

        if (!this.isInteractive()) return;

        const succeeded = event.results.filter((r) => r.success && !r.skipped).length;
        const failed = event.results.filter((r) => !r.success && !r.skipped).length;
        const skipped = event.results.filter((r) => r.skipped).length;
        const duration = this.formatDuration(event.totalDuration);

        const entries: Record<string, string> = {
            'Total Packages': String(event.results.length),
            'Succeeded': String(succeeded),
        };
        if (failed > 0) entries['Failed'] = chalk.red(String(failed));
        if (skipped > 0) entries['Skipped'] = chalk.yellow(String(skipped));
        entries['Duration'] = duration;

        const allSucceeded = failed === 0;
        const title = allSucceeded ? 'Install Orchestration Complete' : 'Install Orchestration Complete (with failures)';

        if (allSucceeded) {
            this.logger.log(successBox(title, entries));
        } else {
            this.logger.log(warningBox(title, entries));
        }
    }

    /**
     * Format duration in human-readable format
     */
    private formatDuration(ms: number): string {
        if (ms < 1000) return `${ms}ms`;
        if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
        const minutes = Math.floor(ms / 60000);
        const seconds = Math.floor((ms % 60000) / 1000);
        return `${minutes}m ${seconds}s`;
    }
}
