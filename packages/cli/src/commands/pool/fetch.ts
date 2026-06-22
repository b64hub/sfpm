import {createPoolServices, setAlias} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {
  AuthInfo, ConfigAggregator, Org, OrgTypes,
} from '@salesforce/core';
import chalk from 'chalk';
import ora from 'ora';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';

export default class PoolFetch extends SfpmCommand {
  static override description = 'fetch an org from a pool'
  static override examples = [
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --alias my-scratch',
    '<%= config.bin %> pool fetch --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --send-to user@example.com',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --all --limit 5',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    alias: Flags.string({char: 'a', description: 'set a local alias for the fetched org'}),
    limit: Flags.integer({description: 'max orgs to return when using --all', min: 1}),
    'my-pool': Flags.boolean({description: 'only fetch from orgs created by the current user'}),
    'send-to': Flags.string({description: 'email org details to this address instead of local login'}),
    'source-tracking': Flags.boolean({default: false, description: 'enable source tracking after fetch'}),
    tag: Flags.string({char: 't', description: 'pool tag to fetch from', required: true}),
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
    const {flags} = await this.parse(PoolFetch);
    const mode = this.outputMode;

    let devhubAlias = flags['target-dev-hub'];
    if (!devhubAlias) {
      const configAggregator = await ConfigAggregator.create();
      devhubAlias = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
    }

    if (!devhubAlias) {
      this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1});
    }

    const spinner = mode === 'interactive' ? ora(`Connecting to ${devhubAlias}...`).start() : undefined;

    const devhub = await Org.create({aliasOrUsername: devhubAlias});

    try {
      const {authenticator, devhubService, fetcher} = await createPoolServices({
        devhub,
        logger: this.sfpmLogger,
        poolType: flags.type as OrgTypes,
      });
      spinner?.succeed(`Connected to ${devhubAlias}`);

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToFetcher(fetcher);

      const postClaimActions: Array<(org: any) => Promise<void>> = [];

      if (flags['send-to']) {
        postClaimActions.push(async org => devhubService.shareOrg(org, {emailAddress: flags['send-to']!}));
      } else {
        postClaimActions.push(org => authenticator.login(org));

        if (flags['source-tracking']) {
          postClaimActions.push(org => authenticator.enableSourceTracking(org));
        }
      }

      const fetchOptions = {
        myPool: flags['my-pool'],
        postClaimActions,
      };

      const org = await fetcher.fetch(flags.tag, fetchOptions);

      // Set alias if requested
      if (flags.alias && org.auth.username) {
        await setAlias(org.auth.username, flags.alias);
        org.auth.alias = flags.alias;
      }

      // Build frontdoor login URL with access token
      let frontDoorUrl: string | undefined;
      if (!flags['send-to'] && org.auth.username) {
        try {
          const authInfo = await AuthInfo.create({username: org.auth.username});
          const fields = authInfo.getFields(true);
          if (fields.accessToken && fields.instanceUrl) {
            frontDoorUrl = `${fields.instanceUrl}/secur/frontdoor.jsp?sid=${fields.accessToken}`;
          }
        } catch {
          // Access token not available — skip frontdoor URL
        }
      }

      if (this.outputMode === 'json') {
        return {data: {...org, frontDoorUrl}, success: true, tag: flags.tag};
      }

      renderer.renderFetchedOrg(org, frontDoorUrl);

      if (flags['send-to']) {
        this.log(chalk.green(`Org details sent to ${flags['send-to']}`));
      }
    } catch (error) {
      spinner?.fail(`Failed to connect to ${devhubAlias}`);

      throw error;
    }
  }
}
