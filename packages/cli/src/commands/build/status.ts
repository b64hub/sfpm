import {Flags} from '@oclif/core';

import SfpmCommand from '../../sfpm-command.js';
import WatchStatus from '../watch/status.js';

/**
 * Thin alias for `watch status --type=build`.
 */
export default class BuildStatus extends SfpmCommand {
  static override description = 'check the status of async build watchers';
  static override examples = [
    '<%= config.bin %> build status',
    '<%= config.bin %> build status --json',
    '<%= config.bin %> build status --poll',
  ];
  static override flags = {
    json: Flags.boolean({description: 'output as JSON'}),
    poll: Flags.boolean({description: 'poll Salesforce directly for current status'}),
  };

  public async execute(): Promise<void> {
    const {flags} = await this.parse(BuildStatus);
    const args = ['--type', 'build'];
    if (flags.json) args.push('--json');
    if (flags.poll) args.push('--poll');
    await WatchStatus.run(args);
  }
}
