import {
  resolveStrategy,
  type WatcherJobType,
  type WatcherState,
  WatcherStateStore,
} from '@b64hub/sfpm-core';
import {Flags} from '@oclif/core';
import chalk from 'chalk';

import SfpmCommand from '../../sfpm-command.js';

export default class WatchStatus extends SfpmCommand {
  static override description = 'check the status of async watcher jobs';
  static override examples = [
    '<%= config.bin %> watch status',
    '<%= config.bin %> watch status --type build',
    '<%= config.bin %> watch status --poll',
    '<%= config.bin %> watch status --json',
  ];
  static override flags = {
    json: Flags.boolean({description: 'output as JSON'}),
    poll: Flags.boolean({description: 'poll Salesforce directly for current status'}),
    type: Flags.string({description: 'filter by job type (build, deploy, test)', options: ['build', 'deploy', 'test']}),
  };

  public async execute(): Promise<void> {
    const {flags} = await this.parse(WatchStatus);
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd();
    const store = new WatcherStateStore(projectDir);
    const jobType = flags.type as undefined | WatcherJobType;

    const entries = await store.list(jobType);

    if (entries.length === 0) {
      if (flags.json) {
        this.logJson({watchers: []});
      } else {
        this.log(jobType ? `No active ${jobType} watchers.` : 'No active watchers.');
      }

      return;
    }

    if (flags.poll) {
      await this.pollEntries(entries, store, flags.json);
      return;
    }

    if (flags.json) {
      this.logJson({
        watchers: entries.map(e => ({
          createdAt: new Date(e.state.createdAt).toISOString(),
          error: e.state.error,
          id: e.id,
          jobType: e.state.jobType,
          result: e.state.result,
          updatedAt: new Date(e.state.updatedAt).toISOString(),
          watcherPid: e.state.watcherPid,
          watcherStatus: e.state.watcherStatus,
        })),
      });
      return;
    }

    this.log('');
    for (const entry of entries) {
      this.renderEntry(entry.id, entry.state);
    }
  }

  private async pollEntries(
    entries: Array<{id: string; state: WatcherState}>,
    store: WatcherStateStore,
    jsonMode?: boolean,
  ): Promise<void> {
    const results: Array<{error?: string; id: string; jobType: string; result: unknown; status: string}> = [];

    for (const entry of entries) {
      const strategy = resolveStrategy(entry.state.jobType);

      try {
        // eslint-disable-next-line no-await-in-loop
        const connection = await strategy.connect(entry.state.auth);
        // eslint-disable-next-line no-await-in-loop
        const outcome = await strategy.poll(connection, entry.state.payload);

        results.push({
          error: outcome.status === 'failed' ? outcome.error : undefined,
          id: entry.id,
          jobType: entry.state.jobType,
          result: outcome.status === 'pending' ? undefined : outcome.result,
          status: outcome.status,
        });

        // Update state file if terminal
        if (outcome.status === 'completed' || outcome.status === 'failed') {
          entry.state.watcherStatus = outcome.status === 'completed' ? 'completed' : 'error';
          entry.state.result = outcome.result;

          if (outcome.status === 'failed') {
            entry.state.error = outcome.error;
          }

          // eslint-disable-next-line no-await-in-loop
          await store.update(entry.id, entry.state);
        }
      } catch (error) {
        results.push({
          error: error instanceof Error ? error.message : String(error),
          id: entry.id,
          jobType: entry.state.jobType,
          result: undefined,
          status: 'error',
        });
      }
    }

    if (jsonMode) {
      this.logJson({watchers: results});
    } else {
      for (const r of results) {
        const icon = r.status === 'completed' ? chalk.green('ok') : r.status === 'failed' ? chalk.red('failed') : chalk.yellow(r.status);
        this.log(`${chalk.cyan(r.id)}  [${r.jobType}]  ${icon}`);
        if (r.error) this.log(`  ${chalk.red(r.error)}`);
        this.log('');
      }
    }
  }

  private renderEntry(id: string, state: WatcherState): void {
    const age = formatAge(Date.now() - state.createdAt);
    const statusColor = statusToColor(state.watcherStatus);
    const pidInfo = state.watcherPid ? ` (PID ${state.watcherPid})` : '';

    this.log(`${chalk.cyan(id)}  [${state.jobType}]  ${statusColor(state.watcherStatus)}${pidInfo}  ${chalk.gray(age)} ago`);

    if (state.error) {
      this.log(`  ${chalk.red(state.error)}`);
    }

    if (state.result) {
      this.log(`  Result: ${JSON.stringify(state.result)}`);
    }

    this.log('');
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function statusToColor(status: string): (text: string) => string {
  switch (status) {
  case 'cancelled': {return chalk.gray;
  }

  case 'completed': {return chalk.green;
  }

  case 'error': {return chalk.red;
  }

  case 'polling': {return chalk.yellow;
  }

  case 'starting': {return chalk.cyan;
  }

  default: {return chalk.gray;
  }
  }
}
