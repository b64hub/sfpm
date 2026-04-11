import {loadSfpmConfig, Logger, WorkspaceSync} from '@b64/sfpm-core'
import {Flags} from '@oclif/core'
import chalk from 'chalk'
import ora from 'ora'

import SfpmCommand from '../sfpm-command.js'

export default class Sync extends SfpmCommand {
  static override description = 'Generate sfdx-project.json from workspace package.json files'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --api-version 63.0',
  ]
  static override flags = {
    'api-version': Flags.string({description: 'Override Salesforce API version (e.g., 63.0)'}),
    json: Flags.boolean({description: 'output result as JSON'}),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(Sync)

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()

    const logger: Logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }

    const spinner = flags.json ? undefined : ora('Syncing workspace...').start()

    try {
      // Load project-level settings from sfpm.config.ts
      const sfpmConfig = await loadSfpmConfig(projectDir, logger)

      const sync = new WorkspaceSync({
        logger,
        namespace: sfpmConfig.namespace,
        projectDir,
        sfdcLoginUrl: sfpmConfig.sfdcLoginUrl,
        sourceApiVersion: flags['api-version'] ?? sfpmConfig.sourceApiVersion,
      })

      const result = await sync.run()

      spinner?.succeed('Workspace synced')

      if (flags.json) {
        this.logJson(result)
        return
      }

      // Display results
      this.log('')
      this.log(chalk.bold('  Packages synced:'))
      for (const pkg of result.packages) {
        this.log(`    ${chalk.cyan(pkg.name)} ${chalk.dim(`(${pkg.type})`)} ${chalk.dim(pkg.packageDir)}`)
      }

      this.log('')
      this.log(`  ${chalk.dim('sfdx-project.json')} ${chalk.green('written')}`)

      if (result.warnings.length > 0) {
        this.log('')
        this.log(chalk.yellow('  Warnings:'))
        for (const warning of result.warnings) {
          this.log(`    ${chalk.yellow('!')} ${warning}`)
        }
      }

      this.log('')
    } catch (error) {
      spinner?.fail('Sync failed')

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false})
      }

      if (error instanceof Error) {
        this.error(error.message, {exit: 1})
      }

      throw error
    }
  }
}
