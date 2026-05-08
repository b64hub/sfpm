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
    '<%= config.bin %> pool fill --tag sb-pool --max 5 --type sandbox -d config/sandbox-def.json -v my-prod-org',
    '<%= config.bin %> pool fill --tag dev-pool --max 10 -d config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'org definition file (scratch org or sandbox)'}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    max: Flags.integer({description: 'maximum number of orgs to allocate (overrides config)', min: 1}),
    'name-pattern': Flags.string({description: 'override sandbox name prefix from definition file (e.g., SB → SB1, SB2, ...)'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
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

    const logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    };

    let devhubAlias = flags['target-dev-hub'];
    if (!devhubAlias) {
      const configAggregator = await ConfigAggregator.create();
      devhubAlias = configAggregator.getPropertyValue<string>('target-dev-hub') ?? undefined;
    }

    const devhubSpinner = mode === 'interactive' ? ora(`Connecting to ${chalk.cyan(devhubAlias)}...`).start() : undefined;

    if (!devhubAlias) {
      this.error('A target dev hub is required. Specify one with --target-dev-hub (-v) or set a default with: sf config set target-dev-hub=<username>', {exit: 1});
    }

    try {
      const devhub = await Org.create({aliasOrUsername: devhubAlias});
      const {manager} = createPoolServices({
        devhub,
        logger,
        poolType,
      });

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToManager(manager);

      if (devhubSpinner) devhubSpinner.text = 'Validating prerequisites...';
      await manager.validatePrerequisites();
      devhubSpinner?.succeed(`${chalk.cyan(devhubAlias)} connected`);

      const orgConfig = await this.loadOrgConfig(logger);
      const config = this.buildPoolConfig(flags, poolType, orgConfig);
      const result = await manager.provision(flags.tag as string, config);

      if (flags.json) {
        this.logJson({...result, events: renderer.getJsonOutput().events, success: result.failed === 0});
        return;
      }

      if (result.failed > 0 && result.succeeded.length === 0) {
        this.error(`Pool provisioning failed: ${result.errors.join(', ')}`, {exit: 1});
      }
    } catch (error) {
      devhubSpinner?.fail('Failed');

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false});
      }

      throw error;
    }
  }

  private buildPoolConfig(flags: Record<string, any>, poolType: OrgTypes, orgConfig?: OrgConfig): PoolConfig {
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const tag = flags.tag as string;

    // Try to find pool config from orgConfig by tag
    const poolDefaults = orgConfig?.pools && !Array.isArray(orgConfig.pools)
      ? orgConfig.pools[tag]
      : undefined;

    const max = (flags.max as number | undefined) ?? poolDefaults?.sizing?.max;
    if (!max) {
      throw new Error('--max is required (or configure sizing.max in pool config)');
    }

    const definitionFile = (flags['definition-file'] as string | undefined) ?? poolDefaults?.definitionFile;
    if (!definitionFile) {
      throw new Error('--definition-file is required (or configure definitionFile in pool config)');
    }

    const sizing = {
      batch: (flags['batch-size'] as number | undefined) ?? poolDefaults?.sizing?.batch ?? 5,
      max,
    };

    if (poolType === OrgTypes.Sandbox) {
      return {
        definitionFile: path.resolve(projectDir, definitionFile),
        namePattern: (flags['name-pattern'] as string | undefined) ?? (poolDefaults as any)?.namePattern,
        sizing,
        type: OrgTypes.Sandbox,
      };
    }

    return {
      definitionFile: path.resolve(projectDir, definitionFile),
      expiryDays: (flags['expiry-days'] as number | undefined) ?? (poolDefaults as any)?.expiryDays,
      sizing,
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
