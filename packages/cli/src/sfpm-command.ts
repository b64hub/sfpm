import type {LogLevel} from '@b64hub/sfpm-core';

import {Command, Flags} from '@oclif/core';
import chalk from 'chalk';
import gradient from 'gradient-string';

import {CliLogger, CliLoggerFactory} from './logger.js';

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const;

/**
 * A base class that provides common funtionality for sfp commands
 */
export default abstract class SfpmCommand extends Command {
  static baseFlags = {
    'log-level': Flags.string({
      default: 'warn',
      description: 'diagnostic log level',
      env: 'SFPM_LOG_LEVEL',
      options: [...LOG_LEVELS],
    }),
  };
  /** Pino-backed logger for diagnostic output (writes to stderr). */
  protected sfpmLogger!: CliLogger;

  /**
   * Command run code goes here
   */
  abstract execute(): Promise<any>;

  /**
   * Entry point of all commands
   */
  async run(): Promise<any> {
    const {flags} = await this.parse(this.constructor as any);

    const isJson = flags.json === true;
    const isQuiet = flags.quiet === true;
    const logLevel = (flags['log-level'] ?? 'warn') as LogLevel;

    this.sfpmLogger = CliLoggerFactory.create({
      level: logLevel,
      pretty: !isJson && !isQuiet,
    });

    if (!this.jsonEnabled()) {
      this.logHeader();
    }

    return this.execute();
  }

  private logHeader(): void {
    const sfpmGradient = gradient(['#0000FF', '#FF0000'], {interpolation: 'hsv'});

    const header
      = sfpmGradient('sfpm')
        + chalk.gray(' • ')
        + chalk.gray(`${this.config.version}`);
    this.log(header);
    this.log('\n');
  }
}
