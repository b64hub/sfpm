import type {AnnotationProperties, Logger, StructuredLogger} from '@b64hub/sfpm-core';

import * as core from '@actions/core';

// ============================================================================
// Types
// ============================================================================

/** A single buffered log entry with level metadata. */
export interface BufferEntry {
  level: 'debug' | 'error' | 'info' | 'trace' | 'warn';
  message: string;
}

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
 * - `child()` creates buffered child loggers stored in an internal registry
 *
 * Top-level methods write immediately. Child loggers buffer their output
 * for later retrieval and flushing by the renderer.
 *
 * @example
 * ```typescript
 * import {createGitHubActionsLogger} from '@b64hub/sfpm-actions';
 *
 * const logger = createGitHubActionsLogger();
 * const service = new InstallOrchestrator(config, graph, options, logger);
 * ```
 */
export class GitHubActionsLogger implements StructuredLogger {
  private readonly _children = new Map<string, BufferEntry[]>();
  private readonly prefix: string;

  constructor(options?: GitHubActionsLoggerOptions) {
    this.prefix = options?.prefix ? `[${options.prefix}] ` : '';
  }

  // --------------------------------------------------------------------------
  // Child logger registry
  // --------------------------------------------------------------------------

  annotate(level: 'error' | 'notice' | 'warning', message: string, properties?: AnnotationProperties): void {
    const props: core.AnnotationProperties = {};
    if (properties?.file) props.file = properties.file;
    if (properties?.line) props.startLine = properties.line;
    if (properties?.endLine) props.endLine = properties.endLine;
    if (properties?.col) props.startColumn = properties.col;
    if (properties?.endColumn) props.endColumn = properties.endColumn;
    if (properties?.title) props.title = properties.title;

    switch (level) {
    case 'error': {
      core.error(message, props);
      break;
    }

    case 'notice': {
      core.notice(message, props);
      break;
    }

    case 'warning': {
      core.warning(message, props);
      break;
    }
    }
  }

  /**
   * Create a buffered child logger. Messages are stored in the internal
   * registry keyed by the binding values, retrievable via `getChildBuffer()`.
   */
  child(bindings: Record<string, string>): Logger {
    const key = Object.values(bindings).join(':');
    if (!this._children.has(key)) {
      this._children.set(key, []);
    }

    const buffer = this._children.get(key)!;
    return new GitHubActionsChildLogger(buffer);
  }

  /** Remove a child buffer after it has been flushed. */
  clearChildBuffer(name: string): void {
    this._children.delete(name);
  }

  debug(message: string): void {
    core.debug(`${this.prefix}${message}`);
  }

  // --------------------------------------------------------------------------
  // Immediate output (top-level)
  // --------------------------------------------------------------------------

  error(message: string): void {
    core.error(`${this.prefix}${message}`);
  }

  /** Retrieve buffered entries for a child logger by key. */
  getChildBuffer(name: string): BufferEntry[] {
    return this._children.get(name) ?? [];
  }

  group(label: string): void {
    core.startGroup(`${this.prefix}${label}`);
  }

  groupEnd(): void {
    core.endGroup();
  }

  /** Check if a child buffer exists for the given key. */
  hasChildBuffer(name: string): boolean {
    return this._children.has(name);
  }

  // --------------------------------------------------------------------------
  // Structured output
  // --------------------------------------------------------------------------

  info(message: string): void {
    core.info(`${this.prefix}${message}`);
  }

  trace(message: string): void {
    core.debug(`${this.prefix}[trace] ${message}`);
  }

  warn(message: string): void {
    core.warning(`${this.prefix}${message}`);
  }
}

// ============================================================================
// Buffered Child Logger (internal)
// ============================================================================

/**
 * Child logger that buffers all messages instead of writing to output.
 * Used by the renderer to flush messages into a group atomically.
 */
class GitHubActionsChildLogger implements Logger {
  private readonly buffer: BufferEntry[];

  constructor(buffer: BufferEntry[]) {
    this.buffer = buffer;
  }

  child(bindings: Record<string, string>): Logger {
    // Nested children share the same buffer — all output stays together
    return this;
  }

  debug(message: string): void {
    this.buffer.push({level: 'debug', message});
  }

  error(message: string): void {
    this.buffer.push({level: 'error', message});
  }

  info(message: string): void {
    this.buffer.push({level: 'info', message});
  }

  trace(message: string): void {
    this.buffer.push({level: 'trace', message});
  }

  warn(message: string): void {
    this.buffer.push({level: 'warn', message});
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
