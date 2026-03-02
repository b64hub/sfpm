import {type OrgKind, type PoolOrg} from '@b64/sfpm-orgs';
import {Flags} from '@oclif/core';
import {printTable} from '@oclif/table';
import chalk from 'chalk';
import ora from 'ora';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';
import {createPoolServices} from '../../utils/pool-bootstrap.js';

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
    tag: Flags.string({char: 't', description: 'pool tag to query', required: true}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target hub org username or alias', required: true}),
    type: Flags.string({
      default: 'scratchOrg',
      description: 'pool type: scratchOrg or sandbox',
      options: ['scratchOrg', 'sandbox'],
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolList);
    const mode = flags.json ? 'json' as const : flags.quiet ? 'quiet' as const : 'interactive' as const;

    const spinner = mode === 'interactive' ? ora('Connecting to hub org...').start() : undefined;

    try {
      const {manager} = await createPoolServices({
        devhub: flags['target-dev-hub'],
        poolType: flags.type as OrgKind,
      });
      spinner?.succeed('Connected to hub org');

      const querySpinner = mode === 'interactive' ? ora(`Fetching orgs for pool "${flags.tag}"...`).start() : undefined;
      const orgs = await manager.list(flags.tag, flags['my-pool']);
      querySpinner?.succeed(`Found ${orgs.length} org(s)`);

      if (flags.json) {
        this.logJson({
          data: orgs, success: true, tag: flags.tag, total: orgs.length,
        });
        return;
      }

      if (mode === 'interactive') {
        const renderer = new PoolProgressRenderer({
          logger: {error: (msg: Error | string) => this.error(msg), log: (msg: string) => this.log(msg)},
          mode,
        });
        renderer.renderOrgList(orgs, flags.tag);

        if (orgs.length > 0) {
          this.renderTable(orgs);
        }
      }
    } catch (error) {
      spinner?.fail('Failed');
      throw error;
    }
  }

  private renderTable(orgs: PoolOrg[]): void {
    printTable({
      borderStyle: 'headers-only-with-underline',
      columns: [
        {key: 'username', name: 'Username'},
        {key: 'alias', name: 'Alias'},
        {key: 'status', name: 'Status'},
        {key: 'expiryDate', name: 'Expires'},
        {key: 'loginURL', name: 'Login URL'},
      ],
      data: orgs.map(org => ({
        alias: org.auth.alias ?? '',
        expiryDate: org.expiry ? new Date(org.expiry).toISOString().split('T')[0] : '',
        loginURL: org.auth.loginUrl ?? '',
        status: org.pool?.status ?? '',
        username: org.auth.username ?? '',
      })),
    });
  }
}

