import {loadSfpmConfig, type Logger} from '@b64hub/sfpm-core';
import {createPoolServices, type OrgConfig, type PoolConfig} from '@b64hub/sfpm-orgs';
import {Flags} from '@oclif/core';
import {ConfigAggregator, Org, OrgTypes} from '@salesforce/core';
import chalk from 'chalk';
import path from 'node:path';
import ora from 'ora';

import type {OutputMode} from '../../ui/renderer-utils.js';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';

export default class PoolFill extends SfpmCommand {
  static override description = 'fill a pool with orgs'
  static override examples = [
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool fill --tag sb-pool --max 5 --type sandbox -d config/sandbox-def.json --sandbox-name-pattern SB -v my-prod-org',
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'org definition file (scratch org or sandbox)'}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    max: Flags.integer({description: 'maximum number of orgs to allocate', min: 1, required: true}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    'sandbox-name-pattern': Flags.string({description: 'sandbox name prefix (e.g., SB → SB1, SB2, ...)'}),
    tag: Flags.string({char: 't', description: 'pool tag', required: true}),
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
    const {flags} = await this.parse(PoolFill);
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
      let devhubAlias = flags['target-dev-hub'];
      if (!devhubAlias) {
        const configAggregator = await ConfigAggregator.create();
        devhubAlias = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
      }

      if (!devhubAlias) {
        this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1});
      }

      const devhub = await Org.create({aliasOrUsername: devhubAlias});
      const {manager} = createPoolServices({
        devhub,
        logger,
        poolType,
      });
      spinner?.succeed(`Connected to ${chalk.cyan(devhubAlias)}`);

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToManager(manager);

      const validationSpinner = mode === 'interactive' ? ora('Validating DevHub prerequisites...').start() : undefined;
      await manager.validatePrerequisites();
      validationSpinner?.succeed(`${chalk.cyan(devhubAlias)} prerequisites validated`);

      const orgConfig = await this.loadOrgConfig(logger);
      const config = this.buildPoolConfig(flags, poolType, orgConfig);
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

  private buildPoolConfig(flags: Record<string, any>, poolType: OrgTypes, orgConfig?: OrgConfig): PoolConfig {
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const sizing = {
      batchSize: flags['batch-size'] as number | undefined,
      maxAllocation: flags.max as number,
    };

    if (poolType === OrgTypes.Sandbox) {
      const sandboxDefaults = orgConfig?.sandbox;
      const definitionFile = (flags['definition-file'] as string | undefined) ?? sandboxDefaults?.definitionFile;

      if (!definitionFile) {
        throw new Error('--definition-file is required for sandbox pools');
      }

      return {
        sandbox: {
          definitionFile: path.resolve(projectDir, definitionFile),
          licenseType: sandboxDefaults?.licenseType ?? 'DEVELOPER',
          namePattern: (flags['sandbox-name-pattern'] as string | undefined) ?? sandboxDefaults?.namePattern ?? 'SB',
        },
        sizing,
        tag: flags.tag as string,
        type: OrgTypes.Sandbox,
      };
    }

    const scratchDefaults = orgConfig?.scratch;
    const definitionFile = (flags['definition-file'] as string | undefined) ?? scratchDefaults?.definitionFile;

    if (!definitionFile) {
      throw new Error('--definition-file is required for scratch org pools');
    }

    return {
      scratch: {
        definitionFile: path.resolve(projectDir, definitionFile),
        expiryDays: (flags['expiry-days'] as number | undefined) ?? scratchDefaults?.expiryDays,
      },
      sizing,
      tag: flags.tag as string,
      type: OrgTypes.Scratch,
    };
  }

  private async loadOrgConfig(logger: Logger): Promise<OrgConfig | undefined> {
    try {
      const sfpmConfig = await loadSfpmConfig(process.env.SFPM_PROJECT_DIR || process.cwd(), logger);
      return sfpmConfig.orgs as OrgConfig | undefined;
    } catch {
      return undefined;
    }
  }
}
