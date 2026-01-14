import SfpCommand from '../../SfpCommand.js';
import { printTable } from '@oclif/table';
import ora from 'ora';

export default class PoolList extends SfpCommand {
    static description = 'List all pools';

    async execute(): Promise<any> {

        const spinner = ora('Fetching pools...').start();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Simulate a delay
        spinner.succeed('Pools fetched successfully');
        this.log('\n');

        const pools = [
            { name: 'Pool A', size: 10 },
            { name: 'Pool B', size: 20 },
        ];

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
}

