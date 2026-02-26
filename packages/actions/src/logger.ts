import * as core from '@actions/core';
import type {AnnotationProperties, StructuredLogger} from '@b64/sfpm-core';

// ============================================================================
// GitHub Actions Logger
// ============================================================================

/**
 * Logger implementation for GitHub Actions using `@actions/core`.
 *
 * Provides structured output that integrates with GitHub Actions features:
 * - Log levels map to Actions debug/info/warning/error commands
 * - `group()` / `groupEnd()` create collapsible log groups in the UI
 * - `annotate()` creates file-level annotations visible on the PR diff
 *
 * @example
 * ```typescript
 * import {createGitHubActionsLogger} from '@b64/sfpm-actions';
 *
 * const logger = createGitHubActionsLogger();
 * const service = new InstallOrchestrator(config, graph, options, logger);
 * ```
 */
export class GitHubActionsLogger implements StructuredLogger {
    private readonly prefix: string;

    constructor(options?: GitHubActionsLoggerOptions) {
        this.prefix = options?.prefix ? `[${options.prefix}] ` : '';
    }

    log(message: string): void {
        core.info(`${this.prefix}${message}`);
    }

    info(message: string): void {
        core.info(`${this.prefix}${message}`);
    }

    warn(message: string): void {
        core.warning(`${this.prefix}${message}`);
    }

    error(message: string): void {
        core.error(`${this.prefix}${message}`);
    }

    debug(message: string): void {
        core.debug(`${this.prefix}${message}`);
    }

    trace(message: string): void {
        // GitHub Actions does not have a trace level — map to debug
        core.debug(`${this.prefix}[trace] ${message}`);
    }

    group(label: string): void {
        core.startGroup(`${this.prefix}${label}`);
    }

    groupEnd(): void {
        core.endGroup();
    }

    annotate(level: 'error' | 'notice' | 'warning', message: string, properties?: AnnotationProperties): void {
        const props: core.AnnotationProperties = {};
        if (properties?.file) props.file = properties.file;
        if (properties?.line) props.startLine = properties.line;
        if (properties?.endLine) props.endLine = properties.endLine;
        if (properties?.col) props.startColumn = properties.col;
        if (properties?.endColumn) props.endColumn = properties.endColumn;
        if (properties?.title) props.title = properties.title;

        switch (level) {
            case 'error':
                core.error(message, props);
                break;
            case 'warning':
                core.warning(message, props);
                break;
            case 'notice':
                core.notice(message, props);
                break;
        }
    }
}

// ============================================================================
// Options
// ============================================================================

export interface GitHubActionsLoggerOptions {
    /** Optional prefix prepended to all log messages (e.g., package name) */
    prefix?: string;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a logger that integrates with GitHub Actions log commands.
 *
 * @example
 * ```typescript
 * const logger = createGitHubActionsLogger();
 * const logger = createGitHubActionsLogger({ prefix: 'validate-pr' });
 * ```
 */
export function createGitHubActionsLogger(options?: GitHubActionsLoggerOptions): GitHubActionsLogger {
    return new GitHubActionsLogger(options);
}
