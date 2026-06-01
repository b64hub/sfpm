import {type WatcherJobType, WatcherStateStore} from '@b64hub/sfpm-core';
import {Flags} from '@oclif/core';

import SfpmCommand from '../../sfpm-command.js';

export default class WatchClean extends SfpmCommand {
  static override description = 'remove completed, errored, and orphaned watcher state files';
  static override examples = [
    '<%= config.bin %> watch clean',
    '<%= config.bin %> watch clean --type build',
    '<%= config.bin %> watch clean --json',
  ];
  static override flags = {
    json: Flags.boolean({description: 'output as JSON'}),
    type: Flags.string({description: 'only clean watchers of this type', options: ['build', 'deploy', 'test']}),
  };

  public async execute(): Promise<void> {
    const {flags} = await this.parse(WatchClean);
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const store = new WatcherStateStore(projectDir);
    const jobType = flags.type as undefined | WatcherJobType;

    const removed = await store.removeStale(jobType);

    if (flags.json) {
      this.logJson({removed});
    } else {
      this.log(`Removed ${removed} stale watcher state file(s).`);
    }
  }
}
