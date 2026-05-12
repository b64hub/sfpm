import {Command, Flags} from '@oclif/core';
import boxen from 'boxen';
import chalk from 'chalk';
import gradient from 'gradient-string';

/**
 * A base class that provides common funtionality for sfp commands
 */
export default abstract class SfpmCommand extends Command {
  /**
   * Command run code goes here
   */
  abstract execute(): Promise<any>;

  /**
   * Entry point of all commands
   */
  async run(): Promise<any> {
    const {flags} = await this.parse(this.constructor as any);

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
