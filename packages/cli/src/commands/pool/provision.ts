import {type PoolConfig} from '@b64/sfpm-orgs';
import {Flags} from '@oclif/core';
import ora from 'ora';

import type {OutputMode} from '../../ui/renderer-utils.js';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';
import {createPoolServices} from '../../utils/pool-bootstrap.js';

export default class PoolProvision extends SfpmCommand {
  static override description = 'provision scratch orgs to fill a pool'
  static override examples = [
    '<%= config.bin %> pool provision --tag dev-pool --max 10 --definition-file config/project-scratch-def.json -v my-devhub',
    '<%= config.bin %> pool provision --tag dev-pool --max 10 --definition-file config/project-scratch-def.json -v my-devhub --json',
  ]
  static override flags = {
    'batch-size': Flags.integer({description: 'max concurrent org creations (default: 5)', min: 1}),
    'definition-file': Flags.string({char: 'd', description: 'scratch org definition file', required: true}),
    'expiry-days': Flags.integer({description: 'scratch org expiry in days (default: 7)', min: 1}),
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    max: Flags.integer({description: 'maximum number of orgs to allocate', min: 1, required: true}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    tag: Flags.string({char: 't', description: 'pool tag', required: true}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target DevHub username or alias', required: true}),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolProvision);
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
      const {manager, poolService} = await createPoolServices({
        devhub: flags['target-dev-hub'],
        logger,
      });
      spinner?.succeed('Connected to DevHub');

      const renderer = new PoolProgressRenderer({
        logger: {
          error: (msg: Error | string) => this.error(msg),
          log: (msg: string) => this.log(msg),
        },
        mode,
      });
      renderer.attachToManager(manager);

      const validationSpinner = mode === 'interactive' ? ora('Validating DevHub prerequisites...').start() : undefined;
      await poolService.validatePrerequisites();
      validationSpinner?.succeed('DevHub prerequisites validated');

      const config: PoolConfig = {
        scratchOrg: {
          definitionFile: flags['definition-file'],
          expiryDays: flags['expiry-days'],
        },
        sizing: {
          batchSize: flags['batch-size'],
          maxAllocation: flags.max,
        },
        tag: flags.tag,
      };

      const result = await poolService.provision(config);

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
}
