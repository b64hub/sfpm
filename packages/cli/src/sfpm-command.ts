import type {LogLevel} from '@b64hub/sfpm-core';

import {Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import gradient from 'gradient-string';

import type {OutputMode} from './ui/renderer-utils.js';

import {CliLogger, CliLoggerFactory} from './logger.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

/**
 * Standard JSON envelope emitted by every command in `--json` mode.
 */
export interface JsonEnvelope<T = unknown> {
  command: string;
  duration: number;
  error?: {code?: string; message: string};
  result?: T;
  status: 'error' | 'success';
}

/**
 * Resolves the output mode from explicit flags and environment signals.
 *
 * Precedence:
 *   1. `--json`  → json
 *   2. `--plain` or `--turbo` → plain
 *   3. CI=true / TERM=dumb / !isTTY → plain (auto-detect)
 *   4. Otherwise → interactive
 */
function resolveOutputMode(flags: {json?: boolean; plain?: boolean; turbo?: boolean}): OutputMode {
  if (flags.json) return 'json';
  if (flags.plain || flags.turbo) return 'plain';
  if (process.env.CI === 'true') return 'plain';
  if (process.env.TERM === 'dumb') return 'plain';
  if (!process.stdout.isTTY) return 'plain';
  return 'interactive';
}

/**
 * A base class that provides common functionality for sfpm commands.
 */
export default abstract class SfpmCommand extends Command {
  static baseFlags = {
    json: Flags.boolean({
      description: 'output result as JSON',
      exclusive: ['plain'],
    }),
    'log-level': Flags.string({
      default: 'warn',
      description: 'diagnostic log level',
      env: 'SFPM_LOG_LEVEL',
      options: [...LOG_LEVELS],
    }),
    plain: Flags.boolean({
      description: 'non-interactive output (no spinners or cursor movement)',
      exclusive: ['json'],
    }),
  };
  /** Resolved output mode for this execution. */
  protected outputMode!: OutputMode;
  /** Pino-backed logger for diagnostic output (writes to stderr). */
  protected sfpmLogger!: CliLogger;

  /**
   * Command implementation. Return a structured result for the JSON envelope,
   * or void for commands that don't produce a meaningful result.
   */
  abstract execute(): Promise<any>;

  /**
   * Entry point for all commands. Resolves output mode, configures logging,
   * executes the command, and handles the JSON envelope.
   */
  async run(): Promise<any> {
    const startTime = Date.now();
    const {flags} = await this.parse(this.constructor as any);

    this.outputMode = resolveOutputMode(flags);
    const logLevel = (flags['log-level'] ?? 'warn') as LogLevel;

    this.sfpmLogger = CliLoggerFactory.create({
      level: logLevel,
      pretty: this.outputMode !== 'json',
    });

    if (this.outputMode !== 'json') {
      this.logHeader();
    }

    try {
      const result = await this.execute();

      if (this.outputMode === 'json') {
        const envelope: JsonEnvelope = {
          command: this.id ?? 'unknown',
          duration: Date.now() - startTime,
          status: 'success',
        };

        if (result !== undefined) {
          envelope.result = result;
        }

        this.log(JSON.stringify(envelope));
      }

      return result;
    } catch (error: unknown) {
      if (this.outputMode === 'json') {
        const err = error instanceof Error ? error : new Error(String(error));
        const envelope: JsonEnvelope = {
          command: this.id ?? 'unknown',
          duration: Date.now() - startTime,
          error: {message: err.message},
          status: 'error',
        };

        this.log(JSON.stringify(envelope));
      }

      throw error;
    }
  }

  private logHeader(): void {
    const sfpmGradient = gradient(['#0000FF', '#FF0000'], {interpolation: 'hsv'});

    const header
      = sfpmGradient('sfpm')
        + chalk.gray(' • ')
        + chalk.gray(`${this.config.version}`);
    this.log(header);
  }
}
