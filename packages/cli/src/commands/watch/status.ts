import {
  resolveStrategy,
  type WatcherJobType,
  type WatcherState,
  WatcherStateStore,
} from '@b64hub/sfpm-core';
import {Flags} from '@oclif/core';
import {printTable} from '@oclif/table';

import SfpmCommand from '../../sfpm-command.js';
import {colorizeStatus, formatAge, truncate} from '../../ui/table.js';

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
      this.logJson({watchers: entries.map(e => toJsonRow(e.id, e.state))});
      return;
    }

    this.printWatcherTable(entries);
  }

  private async pollEntries(
    entries: Array<{id: string; state: WatcherState}>,
    store: WatcherStateStore,
    jsonMode?: boolean,
  ): Promise<void> {
    const rows: Array<{error: string; id: string; status: string; type: string}> = [];

    for (const entry of entries) {
      const strategy = resolveStrategy(entry.state.jobType);

      try {
        // eslint-disable-next-line no-await-in-loop
        const connection = await strategy.connect(entry.state.auth);
        // eslint-disable-next-line no-await-in-loop
        const outcome = await strategy.poll(connection, entry.state.payload);

        rows.push({
          error: outcome.status === 'failed' ? outcome.error : '',
          id: truncate(entry.id, 20),
          status: outcome.status,
          type: entry.state.jobType,
        });

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
        rows.push({
          error: error instanceof Error ? error.message : String(error),
          id: truncate(entry.id, 20),
          status: 'error',
          type: entry.state.jobType,
        });
      }
    }

    if (jsonMode) {
      this.logJson({watchers: rows});
      return;
    }

    printTable({
      borderStyle: 'headers-only-with-underline',
      columns: [
        {key: 'id', name: 'ID'},
        {key: 'type', name: 'Type'},
        {key: 'status', name: 'Status'},
        {key: 'error', name: 'Error'},
      ],
      data: rows.map(r => ({
        ...r,
        error: r.error ? truncate(r.error, 50) : '',
        status: colorizeStatus(r.status),
      })),
    });
  }

  private printWatcherTable(entries: Array<{id: string; state: WatcherState}>): void {
    printTable({
      borderStyle: 'headers-only-with-underline',
      columns: [
        {key: 'id', name: 'ID'},
        {key: 'type', name: 'Type'},
        {key: 'status', name: 'Status'},
        {key: 'pid', name: 'PID'},
        {key: 'age', name: 'Age'},
        {key: 'error', name: 'Error'},
      ],
      data: entries.map(e => toTableRow(e.id, e.state)),
    });
  }
}

// ============================================================================
// Row mappers
// ============================================================================

function toTableRow(id: string, state: WatcherState) {
  return {
    age: `${formatAge(Date.now() - state.createdAt)} ago`,
    error: state.error ? truncate(state.error, 50) : '',
    id: truncate(id, 20),
    pid: state.watcherPid ? String(state.watcherPid) : '',
    status: colorizeStatus(state.watcherStatus),
    type: state.jobType,
  };
}

function toJsonRow(id: string, state: WatcherState) {
  return {
    createdAt: new Date(state.createdAt).toISOString(),
    error: state.error,
    id,
    jobType: state.jobType,
    result: state.result,
    updatedAt: new Date(state.updatedAt).toISOString(),
    watcherPid: state.watcherPid,
    watcherStatus: state.watcherStatus,
  };
}
