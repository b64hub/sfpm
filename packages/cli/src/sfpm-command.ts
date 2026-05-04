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
    const sfpmGradient = gradient(['#FF0000', '#FF00FF', '#0000FF']);

    const header
      = sfpmGradient.multiline('sfpm', {interpolation: 'hsv'})
        + chalk.gray(' • ')
        + chalk.gray(`${this.config.version}`);
    this.log(header);
    this.log('\n');
  }
}
