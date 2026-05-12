import {createPoolServices, type PoolOrg} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {printTable} from '@oclif/table';
import {ConfigAggregator, OrgTypes} from '@salesforce/core';
import ora from 'ora';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';

export default class PoolList extends SfpmCommand {
  static override description = 'list orgs in a pool'
  static override examples = [
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool list --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    'my-pool': Flags.boolean({description: 'only show orgs created by the current user'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    tag: Flags.string({char: 't', description: 'pool tag to query (omit to list all pools)'}),
    'target-dev-hub': Flags.string({
      char: 'v',
      async defaultHelp() {
        try {
          const configAggregator = await ConfigAggregator.create();
          return configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
        } catch {

        }
      },
      description: 'target hub org username or alias',
    }),
    type: Flags.string({
      default: OrgTypes.Scratch,
      description: 'pool type: scratch or sandbox',
      options: [OrgTypes.Scratch, OrgTypes.Sandbox],
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolList);
    const mode = flags.json ? 'json' as const : flags.quiet ? 'quiet' as const : 'interactive' as const;

    try {
      const {devhub} = await connectDevHub({
        alias: flags['target-dev-hub'],
        mode,
      });

      const {manager} = createPoolServices({
        devhub,
        poolType: flags.type as OrgTypes,
      });

      const querySpinner = mode === 'interactive' ? ora(`Fetching orgs${flags.tag ? ` for pool "${flags.tag}"` : ''}...`).start() : undefined;
      const orgs = await manager.list(flags.tag, flags['my-pool']);
      querySpinner?.succeed(`Found ${orgs.length} org(s) ${flags.tag ? `in pool "${flags.tag}"` : ''}`);

      if (flags.json) {
        this.logJson({
          data: orgs, success: true, tag: flags.tag ?? 'all', total: orgs.length,
        });
        return;
      }

      if (mode === 'interactive') {
        const renderer = new PoolProgressRenderer({
          logger: {error: (msg: Error | string) => this.error(msg), log: (msg: string) => this.log(msg)},
          mode,
        });
        renderer.renderOrgList(orgs, flags.tag ?? 'all');
      }
    } catch (error) {
      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false});
        return;
      }

      throw error;
    }
  }
}

