import {createPoolServices} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {ConfigAggregator, OrgTypes} from '@salesforce/core';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';

export default class PoolDelete extends SfpmCommand {
  static override description = 'delete orgs from a pool'
  static override examples = [
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --in-progress-only',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    'in-progress-only': Flags.boolean({description: 'only delete orgs with "In Progress" status'}),
    'my-pool': Flags.boolean({description: 'only delete orgs created by the current user'}),
    tag: Flags.string({char: 't', description: 'pool tag to delete from', required: true}),
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
    const {flags} = await this.parse(PoolDelete);
    const mode = this.outputMode;

    try {
      const {devhub} = await connectDevHub({
        alias: flags['target-dev-hub'],
        mode,
      });

      const {manager} = createPoolServices({
        devhub,
        logger: this.sfpmLogger,
        poolType: flags.type as OrgTypes,
      });

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToManager(manager);

      const result = await manager.delete(flags.tag, {
        inProgressOnly: flags['in-progress-only'],
        myPool: flags['my-pool'],
      });

      return {
        ...result,
        events: renderer.getJsonOutput().events,
        success: result.errors.length === 0,
      };
    } catch (error) {
      throw error;
    }
  }
}
