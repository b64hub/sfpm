import type EventEmitter from 'node:events';

import {DIST_DIR, type LogLevel} from '@b64hub/sfpm-core';
import {Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import gradient from 'gradient-string';
import fs from 'node:fs';
import path from 'node:path';

import type {OutputMode} from './ui/utils/renderer-utils.js';

import {CliLogger, CliLoggerFactory} from './logger.js';
import {suppressStderr} from './utils/suppress.js';

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
function resolveOutputMode(flags: {json?: boolean; 'log-level'?: string; plain?: boolean; turbo?: boolean}): OutputMode {
  if (flags.json) return 'json';
  if (flags.plain || flags.turbo) return 'plain';
  if (process.env.CI === 'true') return 'plain';
  if (process.env.TERM === 'dumb') return 'plain';
  if (!process.stdout.isTTY) return 'plain';
  // Any log level below error writes to stderr — interactive spinners and
  // cursor movement make that output unreadable, so fall back to plain.
  if (flags['log-level'] && flags['log-level'] !== 'error') return 'plain';
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
      default: 'error',
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
   * Directory `writeTurboResult` writes `dist/<command>-result.json` into.
   * `process.cwd()` is only the package directory when turbo itself invokes
   * the per-package npm script — a direct `sfpm build <pkg> --turbo` from
   * the repo root has cwd at the project root instead. Commands that support
   * `--turbo` must set this to the resolved package directory in `execute()`.
   */
  protected turboResultDir?: string;

  /**
   * Create a run-scoped multistream logger for the orchestrator.
   * Always writes full-fidelity JSON to `.sfpm/logs/<runId>.log`.
   * Also routes to the ink UI when `inkBus` is provided, or to stderr otherwise.
   * Returns the logger and the log file path (for display on failure).
   */
  protected createRunLogger(inkBus?: EventEmitter): {logger: CliLogger; logPath: string} {
    return CliLoggerFactory.forRun({
      command: this.id ?? 'sfpm',
      level: this.sfpmLogger.pino.level as any,
      uiBus: inkBus,
    });
  }

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

    if (this.outputMode === 'interactive') {
      this.logHeader();
    }

    try {
      const cap = this.outputMode === 'json' ? null : suppressStderr();
      const result = await this.execute().finally(() => {
        const captured = cap?.release() ?? '';
        if (captured) process.stderr.write(captured);
      });

      const envelope: JsonEnvelope = {
        command: this.id ?? 'unknown',
        duration: Date.now() - startTime,
        status: 'success',
      };

      if (result !== undefined) {
        envelope.result = result;
      }

      // stdout format follows outputMode (json vs the ink UI); the turbo
      // result file is orthogonal — `--turbo` needs it regardless of whether
      // `--json` was also passed, so CI can render plain/interactive progress
      // while still handing the aggregator a file to read.
      if (this.outputMode === 'json') this.log(JSON.stringify(envelope));
      if (flags.turbo) this.writeTurboResult(envelope);

      return result;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      const envelope: JsonEnvelope = {
        command: this.id ?? 'unknown',
        duration: Date.now() - startTime,
        error: {message: err.message},
        status: 'error',
      };

      if (this.outputMode === 'json') this.log(JSON.stringify(envelope));
      if (flags.turbo) this.writeTurboResult(envelope);

      throw error;
    }
  }

  private logHeader(): void {
    const sfpmGradient = gradient(['#3d7fff', '#ff3366'], {interpolation: 'hsv'});

    const header
      = sfpmGradient('sfpm')
        + chalk.gray(' • ')
        + chalk.gray(`${this.config.version}`);
    this.log(header);
  }

  /**
   * `--turbo` mode: persist the JSON envelope to `dist/<command>-result.json`.
   * Written here — after `execute()` has fully returned — so it lands after
   * any dist cleanup the command does mid-run, instead of relying on a shell
   * redirect that opens the file before the build even starts (and loses it
   * when the build empties `dist/`).
   */
  private writeTurboResult(envelope: JsonEnvelope): void {
    try {
      const dir = path.join(this.turboResultDir ?? process.cwd(), DIST_DIR);
      fs.mkdirSync(dir, {recursive: true});
      fs.writeFileSync(path.join(dir, `${this.id ?? 'unknown'}-result.json`), JSON.stringify(envelope));
    } catch (error) {
      this.sfpmLogger?.warn(`Failed to write turbo result file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
