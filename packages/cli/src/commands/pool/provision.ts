import {createPoolServices, type PoolConfig, type SandboxLicenseType} from '@b64/sfpm-orgs';
import {Flags} from '@oclif/core';
import {Org, OrgTypes} from '@salesforce/core';
import ora from 'ora';

import type {OutputMode} from '../../ui/renderer-utils.js';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';

export default class PoolProvision extends SfpmCommand {
  static override description = 'provision orgs to fill a pool'
  static override examples = [
    '<%= config.bin %> pool provision --tag dev-pool --max 10 --definition-file config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool provision --tag sb-pool --max 5 --type sandbox --sandbox-name-pattern SB --license-type DEVELOPER -v my-prod-org',
    '<%= config.bin %> pool provision --tag dev-pool --max 10 --definition-file config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'scratch org definition file'}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    'group-id': Flags.string({description: 'sandbox activation user group ID'}),
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    'license-type': Flags.string({description: 'sandbox license type', options: ['DEVELOPER', 'DEVELOPER PRO', 'FULL', 'PARTIAL']}),
    max: Flags.integer({description: 'maximum number of orgs to allocate', min: 1, required: true}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'sandbox-name-pattern': Flags.string({description: 'sandbox name prefix (e.g., SB → SB1, SB2, ...)'}),
    'source-sandbox': Flags.string({description: 'source sandbox name to clone from'}),
    tag: Flags.string({char: 't', description: 'pool tag', required: true}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target hub org username or alias', required: true}),
    type: Flags.string({
      default: 'scratchOrg',
      description: 'pool type: scratchOrg or sandbox',
      options: ['scratchOrg', 'sandbox'],
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolProvision);
    const mode: OutputMode = flags.json ? 'json' : flags.quiet ? 'quiet' : 'interactive';
    const poolType = flags.type as OrgTypes;

    const spinner = mode === 'interactive' ? ora('Connecting to hub org...').start() : undefined;

    const logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    };

    try {
      const devhub = await Org.create({aliasOrUsername: flags['target-dev-hub']});
      const {manager} = createPoolServices({
        devhub,
        logger,
        poolType,
      });
      spinner?.succeed('Connected to hub org');

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToManager(manager);

      const validationSpinner = mode === 'interactive' ? ora('Validating hub prerequisites...').start() : undefined;
      await manager.validatePrerequisites();
      validationSpinner?.succeed('Hub prerequisites validated');

      const config = this.buildPoolConfig(flags, poolType);
      const result = await manager.provision(config);

      if (flags.json) {
        this.logJson({...result, events: renderer.getJsonOutput().events, success: result.failed === 0});
        return;
      }

      if (result.failed > 0 && result.succeeded.length === 0) {
        this.error(`Pool provisioning failed: ${result.errors.join(', ')}`, {exit: 1});
      }
    } catch (error) {
      spinner?.fail('Failed');

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false});
      }

      throw error;
    }
  }

  private buildPoolConfig(flags: Record<string, any>, poolType: OrgTypes): PoolConfig {
    const sizing = {
      batchSize: flags['batch-size'] as number | undefined,
      maxAllocation: flags.max as number,
    };

    if (poolType === OrgTypes.Sandbox) {
      return {
        sandbox: {
          groupId: flags['group-id'] as string | undefined,
          licenseType: (flags['license-type'] as SandboxLicenseType | undefined) ?? 'DEVELOPER',
          namePattern: (flags['sandbox-name-pattern'] as string | undefined) ?? 'SB',
          sourceSandboxName: flags['source-sandbox'] as string | undefined,
        },
        sizing,
        tag: flags.tag as string,
        type: OrgTypes.Sandbox,
      };
    }

    if (!flags['definition-file']) {
      throw new Error('--definition-file is required for scratch org pools');
    }

    return {
      scratchOrg: {
        definitionFile: flags['definition-file'] as string,
        expiryDays: flags['expiry-days'] as number | undefined,
      },
      sizing,
      tag: flags.tag as string,
      type: OrgTypes.Scratch,
    };
  }
}
