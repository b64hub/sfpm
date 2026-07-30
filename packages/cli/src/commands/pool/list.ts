import {createPoolServices} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {printTable} from '@oclif/table';
import {ConfigAggregator, OrgTypes} from '@salesforce/core';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {formatExpiry, formatStage} from '../../ui/pool-utils.js';
import {renderPoolList} from '../../ui/run-pool-list.js';

export default class PoolList extends SfpmCommand {
  static override description = 'list orgs in a pool'
  static override examples = [
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool list --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool list --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    'my-pool': Flags.boolean({description: 'only show orgs created by the current user'}),
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

  public async execute(): Promise<any> {
    const {flags} = await this.parse(PoolList);
    const mode = this.outputMode;

    const {alias, devhub} = await connectDevHub({
      alias: flags['target-dev-hub'],
      showSpinner: false,
    });

    const {manager} = createPoolServices({
      devhub,
      poolType: flags.type as OrgTypes,
    });

    const orgs = await manager.list(flags.tag, flags['my-pool']);

    if (mode === 'interactive') {
      const instance = renderPoolList(orgs, alias, flags.tag);
      await instance.waitUntilExit();
    } else if (mode !== 'json') {
      // plain / quiet: printTable fallback
      if (orgs.length === 0) {
        this.log(`No orgs found${flags.tag ? ` in pool "${flags.tag}"` : ''}`);
      } else {
        printTable({
          borderStyle: 'headers-only-with-underline',
          columns: [
            {key: 'tag',        name: 'Tag'},
            {key: 'type',       name: 'Type'},
            {key: 'username',   name: 'Username'},
            {key: 'alias',      name: 'Alias'},
            {key: 'stage',      name: 'Stage'},
            {key: 'expiryDate', name: 'Expires'},
          ],
          data: orgs.map(org => ({
            alias: org.auth.alias ?? '',
            expiryDate: org.expiry ? formatExpiry(org.expiry) : '',
            stage: formatStage(org.pool?.stage),
            tag: org.pool?.tag ?? '',
            type: org.orgType ?? '',
            username: org.auth.username ?? '',
          })),
        });
      }
    }

    return {
      data: orgs, success: true, tag: flags.tag ?? 'all', total: orgs.length,
    };
  }
}
