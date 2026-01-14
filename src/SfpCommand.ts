import { Command, Flags } from '@oclif/core';
import { Org } from '@salesforce/core';
import boxen from 'boxen';
import chalk, { colorNames } from 'chalk';

/**
 * A base class that provides common funtionality for sfp commands
 *
 * @extends SfdxCommand
 */
export default abstract class SfpCommand extends Command {

    /**
     * Command run code goes here
     */
    abstract execute(): Promise<any>;

    /**
     * Entry point of all commands
     */
    async run(): Promise<any> {
        const { flags } = await this.parse(SfpCommand);

        if (!this.jsonEnabled()) {
            this.logHeader();
        }

        return this.execute();
    }

    private logHeader(): void {
        const theme = this.config.theme!;

        const header = boxen(
            chalk.hex(theme.bin!).bold('sfp') +
                chalk.gray(' • by ') +
                chalk.hex(theme.bin!)('b64') +
                chalk.gray(' • ') +
                chalk.gray(`v${this.config.version} • ${this.config.pjson.release}`),
            {
                padding: { left: 2, right: 2, top: 0, bottom: 0 },
                margin: { left: 0, right: 0, top: 0, bottom: 1 },
                borderStyle: 'round',
                borderColor: theme.bin,
                dimBorder: false,
            }
        );
        this.log(header);
    }
}
