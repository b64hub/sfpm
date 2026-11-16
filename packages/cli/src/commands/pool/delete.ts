import {createPoolServices, type PoolDeleteResult, PoolStage} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {
  ConfigAggregator, type Org, OrgTypes,
} from '@salesforce/core';
import EventEmitter from 'node:events';

import SfpmCommand from '../../sfpm-command.js';
import {attachPoolDeleteBridge} from '../../ui/adapters/pool-delete-event-bridge.js';
import {connectDevHub} from '../../ui/connect-devhub.js';
import {renderPoolDelete} from '../../ui/renderers/run-pool-delete.js';

export default class PoolDelete extends SfpmCommand {
  static override description = 'delete orgs from a pool'
  static override examples = [
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --exclude-stage Assigned',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool delete --tag dev-pool --tag qa-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    'exclude-stage': Flags.string({
      description: 'exclude orgs in this pool stage from deletion (repeat for multiple; default: none, deletes every stage)',
      multiple: true,
      options: [PoolStage.Assigned, PoolStage.Available, PoolStage.InProgress],
    }),
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
    const {flags} = await this.parse(this.constructor as typeof PoolDelete);
    const mode = this.outputMode;
    const tags = flags.tag as string[];
    const excludeStages = flags['exclude-stage'] as PoolStage[] | undefined;

    const {alias, devhub} = await connectDevHub({
      alias: flags['target-dev-hub'],
      showSpinner: mode === 'interactive',
    });

    // One Ink instance for the whole run — every tag deletes concurrently
    // against its own manager/bus, tagged, so pools appear side by side.
    const uiBus = mode === 'json' ? undefined : new EventEmitter();
    const inkInstance = uiBus ? renderPoolDelete(uiBus, alias, mode === 'interactive' ? 'interactive' : 'plain') : undefined;

    let results: PoolDeleteResult[];
    try {
      results = await Promise.all(tags.map(tag => this.deleteTag({
        devhub, excludeStages, flags, tag, uiBus,
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
    devhub: Org; excludeStages?: PoolStage[]; flags: Record<string, any>; tag: string; uiBus?: EventEmitter;
  }): Promise<PoolDeleteResult> {
    const {devhub, excludeStages, flags, tag, uiBus} = options;

    const {manager} = createPoolServices({
      devhub,
      logger: this.sfpmLogger,
      poolType: flags.type as OrgTypes,
    });

    if (uiBus) {
      attachPoolDeleteBridge(manager.bus, uiBus, tag);
      uiBus.emit('delete:start', {tag});
    }

    const result = await manager.delete(tag, {
      excludeStages,
      myPool: flags['my-pool'],
    });

    if (uiBus) {
      uiBus.emit('delete:done', {deleted: result.deleted.length, errors: result.errors, tag});
    }

    return result;
  }
}
