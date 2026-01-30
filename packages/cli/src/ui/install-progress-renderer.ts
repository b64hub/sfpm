import chalk from 'chalk';
import ora, { Ora } from 'ora';
import boxen from 'boxen';
import { ux } from '@oclif/core';
import type { PackageInstaller } from '@b64/sfpm-core';

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

    constructor(options: { logger: OutputLogger; mode: OutputMode }) {
        this.logger = options.logger;
        this.mode = options.mode;
    }

    /**
     * Attach renderer to package installer
     */
    public attachTo(installer: PackageInstaller): void {
        Object.entries(this.eventConfigs).forEach(([event, config]) => {
            installer.on(event, (data: any) => {
                this.logEvent(event, data);
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
     * Handle install start event
     */
    private handleInstallStart(event: any): void {
        this.timings.installStart = new Date();

        if (this.mode === 'interactive') {
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
        } else if (this.mode === 'quiet') {
            // Only log errors in quiet mode
        }
    }

    /**
     * Handle install complete event
     */
    private handleInstallComplete(event: any): void {
        this.installResult = { success: true };

        if (this.mode === 'interactive') {
            this.spinner?.succeed(
                chalk.green(`Successfully installed ${chalk.bold(event.packageName)}`)
            );

            const duration = this.timings.installStart 
                ? Date.now() - this.timings.installStart.getTime()
                : 0;

            this.logger.log(
                boxen(
                    chalk.green.bold('Installation Complete') +
                        '\n\n' +
                        chalk.gray(`Package: ${event.packageName}`) +
                        '\n' +
                        chalk.gray(`Target Org: ${event.targetOrg}`) +
                        '\n' +
                        chalk.gray(`Duration: ${this.formatDuration(duration)}`),
                    {
                        padding: 1,
                        margin: { top: 1, bottom: 1 },
                        borderStyle: 'round',
                        borderColor: 'green',
                    }
                )
            );
        } else if (this.mode === 'quiet') {
            // Silent success in quiet mode
        }
    }

    /**
     * Handle install error event
     */
    private handleInstallError(event: any): void {
        this.installResult = {
            success: false,
            error: event.error,
        };

        if (this.mode === 'interactive') {
            this.spinner?.fail(
                chalk.red(`Failed to install ${chalk.bold(event.packageName)}`)
            );
        } else if (this.mode === 'quiet') {
            this.logger.error(event.error);
        }
    }

    /**
     * Handle connection start event
     */
    private handleConnectionStart(event: any): void {
        this.timings.connectionStart = new Date();

        if (this.mode === 'interactive') {
            this.spinner?.start(`Connecting to org ${chalk.yellow(event.targetOrg)}...`);
        }
    }

    /**
     * Handle connection complete event
     */
    private handleConnectionComplete(event: any): void {
        if (this.mode === 'interactive') {
            this.spinner?.succeed(
                chalk.green(`Connected to org ${chalk.yellow(event.targetOrg)}`)
            );
        }
    }

    /**
     * Handle deployment start event
     */
    private handleDeploymentStart(event: any): void {
        this.timings.deploymentStart = new Date();

        if (this.mode === 'interactive') {
            this.spinner = ora({
                text: `Deploying metadata to ${chalk.yellow(event.targetOrg)}...`,
                color: 'cyan',
            }).start();
        }
    }

    /**
     * Handle deployment progress event
     */
    private handleDeploymentProgress(event: any): void {
        if (this.mode === 'interactive' && this.spinner) {
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
    }

    /**
     * Handle deployment complete event
     */
    private handleDeploymentComplete(event: any): void {
        if (this.mode === 'interactive') {
            this.spinner?.succeed(
                chalk.green(`Metadata deployed successfully`)
            );

            if (event.numberComponentsDeployed) {
                this.logger.log(
                    chalk.gray(`  Deployed ${event.numberComponentsDeployed} components`)
                );
            }
        }
    }

    /**
     * Handle version install start event
     */
    private handleVersionInstallStart(event: any): void {
        if (this.mode === 'interactive') {
            this.spinner = ora({
                text: `Installing package version ${chalk.cyan(event.packageVersionId)}...`,
                color: 'cyan',
            }).start();
        }
    }

    /**
     * Handle version install progress event
     */
    private handleVersionInstallProgress(event: any): void {
        if (this.mode === 'interactive' && this.spinner) {
            const status = event.status || 'InProgress';
            this.spinner.text = `Installing package: ${status}`;
        }
    }

    /**
     * Handle version install complete event
     */
    private handleVersionInstallComplete(event: any): void {
        if (this.mode === 'interactive') {
            this.spinner?.succeed(
                chalk.green(`Package version installed successfully`)
            );
        }
    }

    /**
     * Handle errors during installation
     */
    public handleError(error: Error): void {
        this.installResult = {
            success: false,
            error,
        };

        if (this.mode === 'interactive') {
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
        } else if (this.mode === 'quiet') {
            this.logger.error(error);
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
