import type {Logger, LogLevel} from '@b64hub/sfpm-core';
import type {Logger as PinoLogger} from 'pino';
import type PinoPretty from 'pino-pretty';

import pino from 'pino';

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
