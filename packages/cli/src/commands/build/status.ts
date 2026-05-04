import {BuildStateStore, type LocalBuildState, ValidationPoller} from '@b64/sfpm-core'
import {Flags} from '@oclif/core'
import {Org} from '@salesforce/core'
import chalk from 'chalk'

import SfpmCommand from '../../sfpm-command.js'

export default class BuildStatus extends SfpmCommand {
  static override description = 'check the status of async package validation watchers'
  static override examples = [
    '<%= config.bin %> build status',
    '<%= config.bin %> build status --json',
    '<%= config.bin %> build status --poll -v my-devhub',
    '<%= config.bin %> build status --clean',
  ]
  static override flags = {
    clean: Flags.boolean({description: 'remove completed and stale state files'}),
    json: Flags.boolean({description: 'output as JSON'}),
    poll: Flags.boolean({description: 'poll Salesforce directly for current status (requires --target-dev-hub)'}),
    'target-dev-hub': Flags.string({char: 'v', description: 'target dev hub username (required with --poll)', env: 'SF_DEV_HUB'}),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(BuildStatus)
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()
    const store = new BuildStateStore(projectDir)

    // --clean: remove stale/completed entries
    if (flags.clean) {
      const removed = await store.removeStale()

      if (flags.json) {
        this.logJson({removed})
      } else {
        this.log(`Removed ${removed} stale state file(s).`)
      }

      return
    }

    const entries = await store.list()

    if (entries.length === 0) {
      if (flags.json) {
        this.logJson({watchers: []})
      } else {
        this.log('No active async validation watchers.')
      }

      return
    }

    // --poll: connect to Salesforce and check status directly
    if (flags.poll) {
      if (!flags['target-dev-hub']) {
        this.error('--target-dev-hub (-v) is required with --poll', {exit: 1})
      }

      await this.pollEntries(entries, flags['target-dev-hub']!, store, flags.json)
      return
    }

    // Default: display state from local files
    if (flags.json) {
      this.logJson({
        watchers: entries.map(e => ({
          createdAt: new Date(e.state.createdAt).toISOString(),
          id: e.id,
          packages: e.state.packages.map(p => p.packageName),
          results: e.state.results,
          updatedAt: new Date(e.state.updatedAt).toISOString(),
          watcherPid: e.state.watcherPid,
          watcherStatus: e.state.watcherStatus,
        })),
      })
      return
    }

    this.log('')
    for (const entry of entries) {
      this.renderEntry(entry.id, entry.state)
    }
  }

  private async pollEntries(
    entries: Array<{id: string; state: LocalBuildState}>,
    devhubUsername: string,
    store: BuildStateStore,
    jsonMode?: boolean,
  ): Promise<void> {
    const devhub = await Org.create({aliasOrUsername: devhubUsername})
    const connection = devhub.getConnection()

    const allResults: Array<{id: string; packages: string[]; results: any[]; status: string}> = []

    for (const entry of entries) {
      const targets = entry.state.packages
      .filter(p => p.packageVersionCreateRequestId)
      .map(p => ({
        packageName: p.packageName,
        packageVersionCreateRequestId: p.packageVersionCreateRequestId!,
        packageVersionId: p.packageVersionId,
      }))

      if (targets.length === 0) continue

      const poller = new ValidationPoller(connection, {maxWaitMs: 10_000, pollingIntervalMs: 5000})
      // eslint-disable-next-line no-await-in-loop
      const results = await poller.pollAll(targets)

      allResults.push({
        id: entry.id,
        packages: targets.map(t => t.packageName),
        results,
        status: results.every(r => r.status === 'Success') ? 'passed' : 'pending-or-failed',
      })

      // Update state file with fresh results
      const allTerminal = results.every(r => r.status === 'Success' || r.status === 'Error')
      if (allTerminal) {
        entry.state.results = results.map(r => ({
          codeCoverage: r.codeCoverage,
          error: r.error,
          hasPassedCodeCoverageCheck: r.hasPassedCodeCoverageCheck,
          packageName: r.packageName,
          packageVersionId: r.packageVersionId,
          status: r.status as 'Error' | 'Success' | 'TimedOut',
        }))
        entry.state.watcherStatus = 'completed'
        // eslint-disable-next-line no-await-in-loop
        await store.update(entry.id, entry.state)
      }
    }

    if (jsonMode) {
      this.logJson({watchers: allResults})
    } else {
      for (const r of allResults) {
        this.log(`${chalk.cyan(r.id)}: ${r.status}`)
        for (const pkg of r.results) {
          const icon = pkg.status === 'Success' ? chalk.green('✓') : pkg.status === 'Error' ? chalk.red('✗') : chalk.yellow('…')
          this.log(`  ${icon} ${pkg.packageName}: ${pkg.status}`)
        }

        this.log('')
      }
    }
  }

  private renderEntry(id: string, state: LocalBuildState): void {
    const age = formatAge(Date.now() - state.createdAt)
    const statusColor = statusToColor(state.watcherStatus)
    const pidInfo = state.watcherPid ? ` (PID ${state.watcherPid})` : ''
    const pkgNames = state.packages.map(p => p.packageName).join(', ')

    this.log(`${chalk.cyan(id)}  ${statusColor(state.watcherStatus)}${pidInfo}  ${chalk.gray(age)} ago`)
    this.log(`  Packages: ${pkgNames}`)

    if (state.results && state.results.length > 0) {
      for (const r of state.results) {
        const icon = r.status === 'Success' ? chalk.green('✓') : chalk.red('✗')
        const coverage = r.codeCoverage === undefined ? '' : ` (coverage: ${r.codeCoverage}%)`
        const error = r.error ? ` — ${r.error}` : ''
        this.log(`    ${icon} ${r.packageName}: ${r.status}${coverage}${error}`)
      }
    }

    this.log('')
  }
}

// ============================================================================
// Helpers
// ============================================================================

function formatAge(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  return `${hours}h ${remainingMinutes}m`
}

function statusToColor(status: string): (text: string) => string {
  switch (status) {
  case 'completed': {return chalk.green
  }

  case 'error': {return chalk.red
  }

  case 'polling': {return chalk.yellow
  }

  case 'starting': {return chalk.cyan
  }

  default: {return chalk.gray
  }
  }
}
