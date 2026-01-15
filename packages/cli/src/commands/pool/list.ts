import SfpCommand from '../../sfp-command.js';
import { printTable } from '@oclif/table';
import ora from 'ora';
import chalk from 'chalk';

export default class PoolList extends SfpCommand {
    static description = 'List all pools';

    async execute(): Promise<any> {

        const spinner = ora('Fetching pools...').start();
        const pools = await this.fetchPools();
        spinner.succeed(chalk.green('Pools fetched successfully'));
        this.log('\n');

        printTable({
            columns: [
                {key: 'name', name: 'Pool Name', width: 30 },
                {key: 'size', name: 'Pool Size' },
            ],
            data: pools,
            borderStyle: 'headers-only-with-underline'
        });

        if (this.jsonEnabled()) {
            this.logJson(pools);
        }
    }

    async fetchPools(): Promise<Array<{ name: string; size: number; }>> {
        await new Promise(resolve => setTimeout(resolve, 1000));
        return [
            { name: 'Pool A', size: 10 },
            { name: 'Pool B', size: 20 },
        ];
    }
}

