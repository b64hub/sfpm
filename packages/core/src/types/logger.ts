// ============================================================================
// Logger Interface
// ============================================================================

/**
 * Core logging interface used across all SFPM packages.
 *
 * Environment-agnostic — implementations can target CLI (chalk/ora),
 * GitHub Actions (@actions/core), or plain console output.
 *
 * Services accept `Logger` as an optional constructor parameter and
 * call methods via optional chaining (`this.logger?.info(...)`).
 *
 * @example
 * ```typescript
 * // Any environment can provide a Logger implementation:
 * const logger = createConsoleLogger();        // plain console
 * const logger = createGitHubActionsLogger();  // @actions/core
 * const logger = createCliLogger(command);     // oclif command
 *
 * const service = new OrgService(hubOrg, logger);
 * ```
 */
export interface Logger {
    log(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    info(message: string): void;
    debug(message: string): void;
    trace(message: string): void;
}

// ============================================================================
// Extended Logger Interface
// ============================================================================

/**
 * Extended logger with structured output capabilities.
 *
 * Provides optional grouping, annotations, and structured data support
 * for environments that support them (e.g., GitHub Actions log groups,
 * CLI spinners/boxes). Falls back gracefully — consumers should check
 * for the extended interface before using these methods.
 *
 * @example
 * ```typescript
 * function logWithGroup(logger: Logger, title: string, fn: () => void): void {
 *   if (isStructuredLogger(logger)) {
 *     logger.group(title);
 *     fn();
 *     logger.groupEnd();
 *   } else {
 *     logger.info(title);
 *     fn();
 *   }
 * }
 * ```
 */
export interface StructuredLogger extends Logger {
    /** Start a collapsible log group (GitHub Actions) or section header (CLI) */
    group(label: string): void;
    /** End the current log group */
    groupEnd(): void;
    /** Emit a file-level annotation (warning/error pinned to a file and line) */
    annotate?(level: 'error' | 'notice' | 'warning', message: string, properties?: AnnotationProperties): void;
}

/**
 * Properties for file-level annotations.
 * Mirrors GitHub Actions annotation properties.
 */
export interface AnnotationProperties {
    /** Column number (1-based) */
    col?: number;
    /** End column number */
    endColumn?: number;
    /** End line number */
    endLine?: number;
    /** File path relative to workspace root */
    file?: string;
    /** Line number (1-based) */
    line?: number;
    /** Annotation title */
    title?: string;
}

// ============================================================================
// Logger Type Guards
// ============================================================================

/**
 * Check if a logger supports structured output (groups, annotations).
 */
export function isStructuredLogger(logger: Logger): logger is StructuredLogger {
    return 'group' in logger && 'groupEnd' in logger;
}

// ============================================================================
// Logger Factories
// ============================================================================

/**
 * A logger that discards all messages. Useful as a default when no
 * logger is provided, avoiding `?.` chains in hot paths.
 */
export const noopLogger: Logger = {
    debug() {},
    error() {},
    info() {},
    log() {},
    trace() {},
    warn() {},
};

/**
 * Create a logger backed by `console.*` methods.
 * Suitable for scripts, tests, and simple Node.js programs.
 */
export function createConsoleLogger(options?: {level?: LogLevel}): Logger {
    const level = options?.level ?? 'info';
    const levelValue = LOG_LEVEL_VALUES[level];

    return {
        debug(message: string) {
            if (levelValue <= LOG_LEVEL_VALUES.debug) console.debug(message);
        },
        error(message: string) {
            console.error(message);
        },
        info(message: string) {
            if (levelValue <= LOG_LEVEL_VALUES.info) console.info(message);
        },
        log(message: string) {
            console.log(message);
        },
        trace(message: string) {
            if (levelValue <= LOG_LEVEL_VALUES.trace) console.trace(message);
        },
        warn(message: string) {
            if (levelValue <= LOG_LEVEL_VALUES.warn) console.warn(message);
        },
    };
}

// ============================================================================
// Log Level
// ============================================================================

export type LogLevel = 'debug' | 'error' | 'info' | 'trace' | 'warn';

const LOG_LEVEL_VALUES: Record<LogLevel, number> = {
    error: 50,
    warn: 40,
    info: 30,
    debug: 20,
    trace: 10,
};