import {WatcherStateStore} from '@b64hub/sfpm-core';
import {Args, Flags} from '@oclif/core';

import SfpmCommand from '../../sfpm-command.js';

export default class WatchCancel extends SfpmCommand {
  static override args = {
    id: Args.string({description: 'watcher ID to cancel', required: true}),
  };
  static override description = 'cancel a running watcher by killing its process';
  static override examples = [
    '<%= config.bin %> watch cancel 1234567890-abc123',
  ];
  static override flags = {
    json: Flags.boolean({description: 'output as JSON'}),
  };

  public async execute(): Promise<void> {
    const {args, flags} = await this.parse(WatchCancel);
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const store = new WatcherStateStore(projectDir);

    const state = await store.load(args.id);
    if (!state) {
      this.error(`Watcher not found: ${args.id}`, {exit: 1});
    }

    // Kill the watcher process if it's running
    if (state.watcherPid) {
      try {
        process.kill(state.watcherPid, 'SIGTERM');
      } catch {
        // Process already exited — that's fine
      }
    }

    // Update state to cancelled
    state.watcherStatus = 'cancelled';
    state.updatedAt = Date.now();
    await store.update(args.id, state);

    if (flags.json) {
      this.logJson({cancelled: true, id: args.id, pid: state.watcherPid});
    } else {
      this.log(`Cancelled watcher ${args.id}${state.watcherPid ? ` (PID ${state.watcherPid})` : ''}`);
    }
  }
}
