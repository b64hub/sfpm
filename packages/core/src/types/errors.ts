/**
 * Custom error thrown when no source changes are detected
 * This is not a failure - it's a successful early exit
 */
export class NoSourceChangesError extends Error {
    public readonly latestVersion: string;
    public readonly sourceHash: string;
    public readonly artifactPath?: string;

    constructor(data: {
        latestVersion: string;
        sourceHash: string;
        artifactPath?: string;
        message?: string;
    }) {
        super(data.message || 'No source changes detected');
        this.name = 'NoSourceChangesError';
        this.latestVersion = data.latestVersion;
        this.sourceHash = data.sourceHash;
        this.artifactPath = data.artifactPath;

        // Maintains proper stack trace for where our error was thrown (only available on V8)
        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, NoSourceChangesError);
        }
    }
}

/**
 * Interface for errors that can be formatted for display
 * Using composition over inheritance for flexibility
 */
export interface DisplayableError {
    toDisplayMessage(): string;
}

/**
 * Utility function to create JSON representation of errors
 */
export function errorToJSON(
    error: Error & { 
        timestamp?: Date; 
        context?: Record<string, any>;
    }
): Record<string, any> {
    return {
        type: error.name,
        message: error.message,
        timestamp: error.timestamp?.toISOString() || new Date().toISOString(),
        context: error.context || {},
        cause: error.cause instanceof Error ? {
            message: error.cause.message,
            name: error.cause.name,
        } : undefined,
    };
}

/**
 * Utility function to preserve error chains
 */
export function preserveErrorChain(error: Error, cause?: Error): void {
    if (cause) {
        error.cause = cause;
        if (cause.stack) {
            error.stack = `${error.stack}\nCaused by: ${cause.stack}`;
        }
    }
}

/**
 * Error that occurs during package build process
 */
export class BuildError extends Error implements DisplayableError {
    public readonly timestamp: Date;
    public readonly context: Record<string, any>;
    public readonly packageName: string;
    public readonly buildStep?: string;

    constructor(
        packageName: string,
        message: string,
        options?: {
            buildStep?: string;
            context?: Record<string, any>;
            cause?: Error;
        }
    ) {
        super(message);
        this.name = 'BuildError';
        this.timestamp = new Date();
        this.context = options?.context || {};
        this.packageName = packageName;
        this.buildStep = options?.buildStep;

        preserveErrorChain(this, options?.cause);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, BuildError);
        }
    }

    public toDisplayMessage(): string {
        const parts: string[] = [`Failed to build package: ${this.packageName}`];
        
        if (this.buildStep) {
            parts.push(`Step: ${this.buildStep}`);
        }
        
        parts.push(`Error: ${this.message}`);
        
        if (this.cause instanceof Error) {
            parts.push(`Cause: ${this.cause.message}`);
        }

        return parts.join('\n');
    }

    public toJSON(): Record<string, any> {
        return errorToJSON(this);
    }
}

/**
 * Error that occurs during package installation
 */
export class InstallationError extends Error implements DisplayableError {
    public readonly timestamp: Date;
    public readonly context: Record<string, any>;
    public readonly packageName: string;
    public readonly packageVersion?: string;
    public readonly targetOrg: string;
    public readonly installationStep?: string;
    public readonly installationMode?: 'version-install' | 'source-deploy';

    constructor(
        packageName: string,
        targetOrg: string,
        message: string,
        options?: {
            packageVersion?: string;
            installationStep?: string;
            installationMode?: 'version-install' | 'source-deploy';
            context?: Record<string, any>;
            cause?: Error;
        }
    ) {
        super(message);
        this.name = 'InstallationError';
        this.timestamp = new Date();
        this.context = options?.context || {};
        this.packageName = packageName;
        this.targetOrg = targetOrg;
        this.packageVersion = options?.packageVersion;
        this.installationStep = options?.installationStep;
        this.installationMode = options?.installationMode;

        preserveErrorChain(this, options?.cause);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, InstallationError);
        }
    }

    public toDisplayMessage(): string {
        const parts: string[] = [];
        
        const pkgIdentifier = this.packageVersion 
            ? `${this.packageName}@${this.packageVersion}`
            : this.packageName;
        
        parts.push(`Failed to install package: ${pkgIdentifier}`);
        parts.push(`Target org: ${this.targetOrg}`);
        
        if (this.installationMode) {
            parts.push(`Installation mode: ${this.installationMode}`);
        }
        
        if (this.installationStep) {
            parts.push(`Step: ${this.installationStep}`);
        }
        
        parts.push(`\nError: ${this.message}`);
        
        if (this.cause instanceof Error) {
            parts.push(`\nUnderlying cause: ${this.cause.message}`);
        }

        return parts.join('\n');
    }

    public toJSON(): Record<string, any> {
        return errorToJSON(this);
    }
}

/**
 * Error that occurs when a strategy cannot be found or applied
 */
export class StrategyError extends Error implements DisplayableError {
    public readonly timestamp: Date;
    public readonly context: Record<string, any>;
    public readonly strategyType: string;
    public readonly availableStrategies: string[];

    constructor(
        strategyType: string,
        message: string,
        availableStrategies: string[] = [],
        options?: {
            context?: Record<string, any>;
            cause?: Error;
        }
    ) {
        super(message);
        this.name = 'StrategyError';
        this.timestamp = new Date();
        this.context = options?.context || {};
        this.strategyType = strategyType;
        this.availableStrategies = availableStrategies;

        preserveErrorChain(this, options?.cause);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, StrategyError);
        }
    }

    public toDisplayMessage(): string {
        const parts: string[] = [
            `Strategy error: ${this.message}`,
            `Strategy type: ${this.strategyType}`,
        ];

        if (this.availableStrategies.length > 0) {
            parts.push(`Available strategies: ${this.availableStrategies.join(', ')}`);
        }

        return parts.join('\n');
    }

    public toJSON(): Record<string, any> {
        return errorToJSON(this);
    }
}

/**
 * Error that occurs during artifact operations
 */
export class ArtifactError extends Error implements DisplayableError {
    public readonly timestamp: Date;
    public readonly context: Record<string, any>;
    public readonly packageName: string;
    public readonly version?: string;
    public readonly operation: 'read' | 'write' | 'extract' | 'validate';

    constructor(
        packageName: string,
        operation: 'read' | 'write' | 'extract' | 'validate',
        message: string,
        options?: {
            version?: string;
            context?: Record<string, any>;
            cause?: Error;
        }
    ) {
        super(message);
        this.name = 'ArtifactError';
        this.timestamp = new Date();
        this.context = options?.context || {};
        this.packageName = packageName;
        this.operation = operation;
        this.version = options?.version;

        preserveErrorChain(this, options?.cause);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, ArtifactError);
        }
    }

    public toDisplayMessage(): string {
        const pkgIdentifier = this.version 
            ? `${this.packageName}@${this.version}`
            : this.packageName;

        return [
            `Artifact ${this.operation} failed for: ${pkgIdentifier}`,
            `Error: ${this.message}`,
            this.cause instanceof Error ? `Cause: ${this.cause.message}` : null,
        ].filter(Boolean).join('\n');
    }

    public toJSON(): Record<string, any> {
        return errorToJSON(this);
    }
}

/**
 * Error that occurs during dependency resolution
 */
export class DependencyError extends Error implements DisplayableError {
    public readonly timestamp: Date;
    public readonly context: Record<string, any>;
    public readonly packageName: string;
    public readonly missingDependencies: string[];

    constructor(
        packageName: string,
        missingDependencies: string[],
        message?: string,
        options?: {
            context?: Record<string, any>;
            cause?: Error;
        }
    ) {
        super(message || `Package ${packageName} has unresolved dependencies`);
        this.name = 'DependencyError';
        this.timestamp = new Date();
        this.context = options?.context || {};
        this.packageName = packageName;
        this.missingDependencies = missingDependencies;

        preserveErrorChain(this, options?.cause);

        if (Error.captureStackTrace) {
            Error.captureStackTrace(this, DependencyError);
        }
    }

    public toDisplayMessage(): string {
        return [
            `Dependency error for package: ${this.packageName}`,
            `Missing dependencies:`,
            ...this.missingDependencies.map(dep => `  - ${dep}`),
            this.message !== `Package ${this.packageName} has unresolved dependencies` ? `\n${this.message}` : null,
        ].filter(Boolean).join('\n');
    }

    public toJSON(): Record<string, any> {
        return errorToJSON(this);
    }
}

