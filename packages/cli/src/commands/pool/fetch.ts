import {Flags} from '@oclif/core';
import {Org, OrgTypes} from '@salesforce/core';
import chalk from 'chalk';
import ora from 'ora';

import type {OutputMode} from '../../ui/renderer-utils.js';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';
import {createPoolServices} from '../../utils/pool-bootstrap.js';

export default class PoolFetch extends SfpmCommand {
  static override description = 'fetch an org from a pool'
  static override examples = [
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool fetch --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --send-to user@example.com',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --all --limit 5',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    limit: Flags.integer({description: 'max orgs to return when using --all', min: 1}),
    'my-pool': Flags.boolean({description: 'only fetch from orgs created by the current user'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'send-to': Flags.string({description: 'email org details to this address instead of local login'}),
    'source-tracking': Flags.boolean({default: false, description: 'enable source tracking after fetch'}),
    tag: Flags.string({char: 't', description: 'pool tag to fetch from', required: true}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target hub org username or alias', required: true}),
    type: Flags.string({
      default: OrgTypes.Scratch,
      description: 'pool type: scratch or sandbox',
      options: [OrgTypes.Scratch, OrgTypes.Sandbox],
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolFetch);
    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';

    const spinner = mode === 'interactive' ? ora('Connecting to DevHub...').start() : undefined;

    const logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    };

    try {
      const {authenticator, devHub, fetcher} = await createPoolServices({
        devhub: flags['target-dev-hub'],
        logger,
        poolType: flags.type,
      });
      spinner?.succeed('Connected to hub org');

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToFetcher(fetcher);

      // Compose post-claim actions based on flags
      const postClaimActions = flags['send-to']
        ? [async (org: any) => devHub.shareOrg(org, {emailAddress: flags['send-to']!})]
        : [
          (org: any) => authenticator.login(org),
          ...(flags['source-tracking'] ? [(org: any) => authenticator.enableSourceTracking(org)] : []),
        ];

      const fetchOptions = {
        myPool: flags['my-pool'],
        postClaimActions,
        tag: flags.tag,
      };

      const org = await fetcher.fetch(fetchOptions);

      if (flags.json) {
        this.logJson({data: org, success: true, tag: flags.tag});
        return;
      }

      renderer.renderFetchedOrg(org);

      if (flags['send-to']) {
        this.log(chalk.green(`Org details sent to ${flags['send-to']}`));
      }
    } catch (error) {
      spinner?.fail('Failed');

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false});
      }

      throw error;
    }
  }
}
