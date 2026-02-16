import {Flags} from '@oclif/core';
import ora from 'ora';

import type {OutputMode} from '../../ui/renderer-utils.js';

import SfpmCommand from '../../sfpm-command.js';
import {PoolProgressRenderer} from '../../ui/pool-progress-renderer.js';
import {createPoolServices} from '../../utils/pool-bootstrap.js';

export default class PoolDelete extends SfpmCommand {
  static override description = 'delete scratch orgs from a pool'
  static override examples = [
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --in-progress-only',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --my-pool',
    '<%= config.bin %> pool delete --tag dev-pool -v my-devhub --json',
  ]
  static override flags = {
    'in-progress-only': Flags.boolean({description: 'only delete orgs with "In Progress" status'}),
    json: Flags.boolean({description: 'output as JSON', exclusive: ['quiet']}),
    'my-pool': Flags.boolean({description: 'only delete orgs created by the current user'}),
    quiet: Flags.boolean({char: 'q', description: 'only show errors', exclusive: ['json']}),
    tag: Flags.string({char: 't', description: 'pool tag to delete from', required: true}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target DevHub username or alias', required: true}),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(PoolDelete);
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
      const {manager} = await createPoolServices({
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

      const result = await manager.delete({
        inProgressOnly: flags['in-progress-only'],
        myPool: flags['my-pool'],
        tag: flags.tag,
      });

      if (flags.json) {
        this.logJson({
          ...result,
          events: renderer.getJsonOutput().events,
          success: result.errors.length === 0,
        });
      }

      // Interactive summary already rendered by the renderer via events
    } catch (error) {
      spinner?.fail('Failed');

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false});
      }

      throw error;
    }
  }
}
