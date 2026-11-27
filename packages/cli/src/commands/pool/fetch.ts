import {type PackageDiffEntry, PackageManager, ProjectService} from '@b64hub/sfpm-core';
import {createPoolServices, setAlias} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {printTable} from '@oclif/table';
import {
  AuthInfo, Config, ConfigAggregator, Org, OrgConfigProperties, OrgTypes,
} from '@salesforce/core';
import chalk from 'chalk';

import SfpmCommand from '../../sfpm-command.js';
import {successBox} from '../../ui/boxes.js';
import {formatExpiry} from '../../ui/utils/pool-utils.js';
import {terminalLink} from '../../ui/utils/renderer-utils.js';

export default class PoolFetch extends SfpmCommand {
  static override description = 'fetch an org from a pool'
  static override examples = [
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --alias my-scratch',
    '<%= config.bin %> pool fetch --tag sb-pool --type sandbox -v my-prod-org',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --send-to user@example.com',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --no-reset-tracking',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --package-diff',
    '<%= config.bin %> pool fetch --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    alias: Flags.string({char: 'a', description: 'set a local alias for the fetched org'}),
    limit: Flags.integer({description: 'max orgs to return when using --all', min: 1}),
    'my-pool': Flags.boolean({description: 'only fetch from orgs created by the current user'}),
    'package-diff': Flags.boolean({
      default: false,
      description: 'show differences between packages installed in the fetched org and packages defined in the project',
    }),
    'reset-tracking': Flags.boolean({
      allowNo: true,
      default: true,
      description: 'reset local and remote source tracking for the fetched org (requires an sfdx project; skipped with a warning if reset fails or isn\'t applicable)',
    }),
    'send-to': Flags.string({description: 'email org details to this address instead of local login'}),
    'set-default': Flags.boolean({allowNo: true, default: true, description: 'set the fetched org as the default target org'}),
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

    const devhub = await Org.create({aliasOrUsername: devhubAlias});

    const {authenticator, devhubService, fetcher} = await createPoolServices({
      devhub,
      logger: this.sfpmLogger,
      poolType: flags.type as OrgTypes,
    });

    const postClaimActions: Array<(org: any) => Promise<void>> = [];

    if (flags['send-to']) {
      postClaimActions.push(async org => devhubService.shareOrg(org, {emailAddress: flags['send-to']!}));
    } else {
      postClaimActions.push(org => authenticator.login(org));

      if (flags['source-tracking']) {
        postClaimActions.push(org => authenticator.enableSourceTracking(org));
      }

      if (flags['reset-tracking']) {
        postClaimActions.push(async org => {
          try {
            await authenticator.resetSourceTracking(org);
          } catch (error) {
            this.warn(`Source tracking not reset: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
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

    // Set as default target org
    if (flags['set-default'] && !flags['send-to'] && org.auth.username) {
      await Config.update(false, OrgConfigProperties.TARGET_ORG, org.auth.username);
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

    let packageDiff: PackageDiffEntry[] | undefined;
    if (flags['package-diff'] && !flags['send-to'] && org.auth.username) {
      try {
        const targetOrg = await Org.create({aliasOrUsername: org.auth.username});
        const project = await ProjectService.getInstance();
        packageDiff = await PackageManager.getInstance(targetOrg, this.sfpmLogger).diffWithProject(project.getAllPackageDefinitions());
      } catch (error) {
        this.warn(`Package diff unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    if (this.outputMode === 'json') {
      return {
        data: {...org, frontDoorUrl},
        packageDiff,
        success: true,
        tag: flags.tag,
      };
    }

    const loginUrl     = frontDoorUrl ?? org.auth.loginUrl;
    const loginDisplay = loginUrl ? terminalLink('Open', loginUrl) : undefined;
    this.log('');
    this.log(successBox('Fetched Org', {
      ...(org.auth.alias   ? {Alias: org.auth.alias}                   : {}),
      ...(org.expiry       ? {Expires: formatExpiry(org.expiry)}       : {}),
      ...(loginDisplay     ? {'Login URL': loginDisplay}               : {}),
      ...(org.orgId        ? {'Org ID': org.orgId}                     : {}),
      ...(org.auth.password ? {Password: org.auth.password}           : {}),
      Type: org.orgType ?? 'scratch',
      Username: org.auth.username ?? 'N/A',
    }));

    if (flags['send-to']) {
      this.log(chalk.green(`Org details sent to ${flags['send-to']}`));
    }

    if (packageDiff) {
      if (packageDiff.every(entry => entry.status === 'match')) {
        this.log(chalk.green('Packages in sync with project'));
      } else {
        printTable({
          borderStyle: 'headers-only-with-underline',
          columns: [
            {key: 'name', name: 'Package'},
            {key: 'projectVersion', name: 'Project'},
            {key: 'orgVersion', name: 'Org'},
            {key: 'status', name: 'Status'},
          ],
          data: packageDiff.map(entry => ({...entry, orgVersion: entry.orgVersion ?? '', projectVersion: entry.projectVersion ?? ''})),
          title: 'Package Diff',
        });
      }
    }
  }
}

