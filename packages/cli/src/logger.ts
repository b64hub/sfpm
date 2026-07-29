import type {Logger, LogLevel} from '@b64hub/sfpm-core';
import type EventEmitter from 'node:events';
import type {Logger as PinoLogger} from 'pino';
import type PinoPretty from 'pino-pretty';

import {findSfpmRoot} from '@b64hub/sfpm-core';
import {randomBytes} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import path from 'node:path';
import pino from 'pino';

import {createPinoBridge} from './ui/pino-bridge.js';

// ============================================================================
// CLI Logger Factory
// ============================================================================

export interface CliLoggerOptions {
  /** Log level threshold (default: 'warn') */
  level?: LogLevel;
  /** Use pretty-printed output instead of JSON (default: true) */
  pretty?: boolean;
}

/**
 * Singleton factory for the CLI pino logger.
 *
 * Creates a pino instance that writes to stderr, leaving stdout
 * clean for command output and --json results. Wraps the pino
 * instance in the core Logger interface so it can be injected
 * into core services via DI.
 *
 * @example
 * ```typescript
 * // In SfpmCommand.run():
 * const logger = CliLoggerFactory.create({ level: 'debug', pretty: true });
 *
 * // Child logger with package context:
 * const pkgLogger = CliLoggerFactory.child(logger, { package: '@b64/my-pkg' });
 * ```
 */
export interface ForRunOptions {
  /** Command name/slug embedded in the run ID and log filename. */
  command: string;
  /** Minimum log level for the stderr stream in non-interactive mode (default: 'warn'). */
  level?: LogLevel;
  /** When provided (interactive path), logs are bridged to the ink UI instead of stderr. */
  uiBus?: EventEmitter;
}

export class CliLoggerFactory {
  private static instance: PinoLogger | undefined;

  /**
   * Create a child Logger with bound context fields.
   * Every message logged through the child includes the context.
   */
  static child(parent: CliLogger, context: Record<string, string>): CliLogger {
    return new CliLogger(parent.pino.child(context));
  }

  /**
   * Create a Logger backed by pino writing to stderr.
   * Subsequent calls return a wrapper around the same pino instance.
   */
  static create(options?: CliLoggerOptions): CliLogger {
    const level = mapLevel(options?.level ?? 'warn');
    const pretty = options?.pretty ?? true;

    if (CliLoggerFactory.instance) {
      CliLoggerFactory.instance.level = level;
    } else {
      CliLoggerFactory.instance = createPinoInstance(level, pretty);
    }

    return new CliLogger(CliLoggerFactory.instance);
  }

  /**
   * Create a run-scoped multistream logger that always writes full-fidelity
   * JSON to `.sfpm/logs/<runId>.log` at the project root, and additionally:
   *   - interactive path: routes logs to the ink UI via `log:append` events
   *   - non-interactive path: mirrors logs to stderr at the configured level
   *
   * The project root is resolved by walking up from CWD looking for
   * `sfpm.config.{ts,js,mjs}`. Falls back to CWD if none is found.
   *
   * @returns the logger and the absolute path to the log file.
   */
  static forRun(options: ForRunOptions): {logger: CliLogger; logPath: string} {
    const projectRoot = findSfpmRoot(process.cwd()) ?? process.cwd();
    const logDir = path.join(projectRoot, '.sfpm', 'logs');
    mkdirSync(logDir, {recursive: true});

    const slug = options.command.replaceAll(/[:/\\]/g, '-');
    const logPath = path.join(logDir, `${generateRunId(slug)}.log`);

    const fileStream = pino.destination({dest: logPath, sync: false});
    const streams: Array<{level?: string; stream: {write(msg: string): void}}> = [
      {level: 'debug', stream: fileStream},
    ];

    if (options.uiBus) {
      // Interactive: route to ink UI; stderr is owned by ink so we skip it.
      streams.unshift({stream: createPinoBridge(options.uiBus)});
    } else {
      // Non-interactive: mirror to stderr at the configured log level.
      streams.unshift({
        level: mapLevel(options.level ?? 'warn'),
        stream: pino.destination({dest: 2, sync: false}),
      });
    }

    return {
      logger: new CliLogger(pino({level: 'debug'}, pino.multistream(streams))),
      logPath,
    };
  }

  /** Reset the singleton (for testing). */
  static reset(): void {
    CliLoggerFactory.instance = undefined;
  }
}

// ============================================================================
// CLI Logger Implementation
// ============================================================================

/**
 * Logger implementation backed by pino. Conforms to the core Logger
 * interface so it can be injected into any core service.
 */
export class CliLogger implements Logger {
  /** @internal */
  readonly pino: PinoLogger;

  constructor(pinoInstance: PinoLogger) {
    this.pino = pinoInstance;
  }

  child(bindings: Record<string, string>): CliLogger {
    return new CliLogger(this.pino.child(bindings));
  }

  debug(message: string): void {
    this.pino.debug(message);
  }

  error(message: string): void {
    this.pino.error(message);
  }

  info(message: string): void {
    this.pino.info(message);
  }

  trace(message: string): void {
    this.pino.trace(message);
  }

  warn(message: string): void {
    this.pino.warn(message);
  }
}

// ============================================================================
// Internal Helpers
// ============================================================================

/** Map SFPM LogLevel names to pino level names. */
function mapLevel(level: LogLevel): string {
  return level;
}

/**
 * Generate a unique, chronologically-sortable run ID:
 *   {YYYYMMDDTHHMMSS}-{command}-{8hex}
 *
 * The timestamp prefix ensures lexicographic sort == chronological sort.
 * The 4-byte hex suffix ensures uniqueness for parallel runs (e.g. turborepo).
 */
function generateRunId(command: string): string {
  const d = new Date();
  // eslint-disable-next-line unicorn/consistent-function-scoping -- simple function used once
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}T${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${ts}-${command}-${randomBytes(4).toString('hex')}`;
}

function createPinoInstance(level: string, pretty: boolean): PinoLogger {
  if (pretty) {
    return pino({
      level,
      transport: {
        options: {
          colorize: true,
          ignore: 'pid,hostname',
          translateTime: 'HH:MM:ss',
        } satisfies PinoPretty.PrettyOptions,
        target: 'pino-pretty',
      },
    }, pino.destination({dest: 2, sync: false}));
  }

  return pino({level}, pino.destination({dest: 2, sync: false}));
}
