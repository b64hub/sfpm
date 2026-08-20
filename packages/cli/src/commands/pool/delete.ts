import {createPoolServices, type PoolDeleteResult} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {
  ConfigAggregator, type Org, OrgTypes,
} from '@salesforce/core';
import EventEmitter from 'node:events';

import SfpmCommand from '../../sfpm-command.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {attachPoolDeleteBridge} from '../../ui/pool-delete-event-bridge.js';
import {renderPoolDelete} from '../../ui/run-pool-delete.js';

export default class PoolDelete extends SfpmCommand {
  static override description = 'delete orgs from a pool'
  static override examples = [
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --in-progress-only',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool delete --tag dev-pool --tag qa-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    'in-progress-only': Flags.boolean({description: 'only delete orgs with "In Progress" status'}),
    'my-pool': Flags.boolean({description: 'only delete orgs created by the current user'}),
    tag: Flags.string({
      char: 't', description: 'pool tag to delete from (repeat to delete from multiple pools)', multiple: true, required: true,
    }),
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
    const tags = flags.tag as string[];

    const {alias, devhub} = await connectDevHub({
      alias: flags['target-dev-hub'],
      showSpinner: mode === 'interactive',
    });

    // One Ink instance for the whole run — every tag deletes concurrently
    // against its own manager/bus, tagged, so pools appear side by side.
    const uiBus = mode === 'interactive' ? new EventEmitter() : undefined;
    const inkInstance = mode === 'interactive' ? renderPoolDelete(uiBus!, alias) : undefined;

    let results: PoolDeleteResult[];
    try {
      results = await Promise.all(tags.map(tag => this.deleteTag({
        devhub, flags, mode, tag, uiBus,
      })));
    } catch (error) {
      inkInstance?.unmount();
      throw error;
    }

    if (inkInstance) {
      await inkInstance.waitUntilExit();
    }

    const enriched = results.map(r => ({...r, events: [], success: r.errors.length === 0}));
    return tags.length === 1 ? enriched[0] : {results: enriched, success: enriched.every(r => r.success)};
  }

  private async deleteTag(options: {
    devhub: Org; flags: Record<string, any>; mode: string; tag: string; uiBus?: EventEmitter;
  }): Promise<PoolDeleteResult> {
    const {devhub, flags, mode, tag, uiBus} = options;

    const {manager} = createPoolServices({
      devhub,
      logger: this.sfpmLogger,
      poolType: flags.type as OrgTypes,
    });

    if (mode === 'interactive') {
      attachPoolDeleteBridge(manager.bus, uiBus!, tag);
      uiBus!.emit('delete:start', {tag});
    }

    const result = await manager.delete(tag, {
      inProgressOnly: flags['in-progress-only'],
      myPool: flags['my-pool'],
    });

    if (mode === 'interactive') {
      uiBus!.emit('delete:done', {deleted: result.deleted.length, errors: result.errors, tag});
    }

    return result;
  }
}
