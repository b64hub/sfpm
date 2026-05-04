import {Git, ProjectService} from '@b64/sfpm-core'
import {Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'node:path'
import ora from 'ora'

import SfpmCommand from '../../../sfpm-command.js'

interface ConfigCheck {
  fix?: string
  message: string
  name: string
  passed: boolean
}

export default class Init extends SfpmCommand {
  static override description = 'Verify project configuration and setup requirements'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --fix',
  ]
  static override flags = {
    fix: Flags.boolean({
      char: 'f',
      default: false,
      description: 'Attempt to fix issues automatically',
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(Init)

    this.log(chalk.bold('\nChecking SFPM Project Configuration\n'))

    const checks: ConfigCheck[] = []

    checks.push(
      await this.checkSfdxProject(),
      await this.checkGitRepo(),
      await this.checkGitRemote(),
      await this.checkPackageDirectories(),
    );

    this.displayResults(checks)

    if (flags.fix) {
      await this.attemptFixes(checks)
    }

    // Summary
    const passed = checks.filter(c => c.passed).length
    const failed = checks.filter(c => !c.passed).length

    this.log('')
    if (failed === 0) {
      this.log(chalk.green(` All checks passed (${passed}/${checks.length})`))
      this.log(chalk.dim('\nYour project is ready to use SFPM!\n'))
    } else {
      this.log(chalk.yellow(`  ${passed}/${checks.length} checks passed, ${failed} failed`))
      if (!flags.fix) {
        this.log(chalk.dim('\nRun with --fix flag to attempt automatic fixes\n'))
      }

      this.exit(1)
    }
  }

  private async attemptFixes(checks: ConfigCheck[]): Promise<void> {
    const failed = checks.filter(c => !c.passed)

    if (failed.length === 0) {
      return
    }

    this.log(chalk.bold('\nAttempting Automatic Fixes\n'))

    for (const check of failed) {
      // Currently, we only provide guidance, not automatic fixes
      // This is intentional - configuration like git remotes requires user input
      this.log(chalk.yellow(`Cannot auto-fix: ${check.name}`))
      this.log(chalk.dim(`  ${check.fix}\n`))
    }
  }

  private async checkGitRemote(): Promise<ConfigCheck> {
    try {
      // Check if .git exists first
      const gitDir = path.join(process.cwd(), '.git')
      const isRepo = await fs.pathExists(gitDir)

      if (!isRepo) {
        return {
          fix: 'Initialize git first with: git init',
          message: 'Not a git repository',
          name: 'Git Remote',
          passed: false,
        }
      }

      const git = new Git(process.cwd())
      const remoteUrl = await git.getRemoteOriginUrl()

      return {
        fix: remoteUrl
          ? undefined
          : 'Add remote with: git remote add origin <repository-url>',
        message: remoteUrl
          ? `Remote origin: ${remoteUrl}`
          : 'No remote origin configured',
        name: 'Git Remote',
        passed: Boolean(remoteUrl),
      }
    } catch {
      return {
        fix: 'Add remote with: git remote add origin <repository-url>',
        message: 'No remote origin configured',
        name: 'Git Remote',
        passed: false,
      }
    }
  }

  private async checkGitRepo(): Promise<ConfigCheck> {
    const gitDir = path.join(process.cwd(), '.git')
    const exists = fs.pathExistsSync(gitDir)

    return {
      fix: exists ? undefined : 'Initialize git with: git init',
      message: exists ? 'Git repository initialized' : 'Not a git repository',
      name: 'Git Repository',
      passed: exists,
    }
  }

  private async checkPackageDirectories(): Promise<ConfigCheck> {
    try {
      const projectService = await ProjectService.getInstance(process.cwd())
      const packages = projectService.getAllPackageNames()

      return {
        fix: packages.length > 0
          ? undefined
          : 'Add packages with: sf package create',
        message: packages.length > 0
          ? `Found ${packages.length} package(s): ${packages.join(', ')}`
          : 'No packages defined in sfdx-project.json',
        name: 'Package Directories',
        passed: packages.length > 0,
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error'
      return {
        fix: 'Ensure sfdx-project.json is valid and accessible',
        message: `Could not read project configuration: ${errorMessage}`,
        name: 'Package Directories',
        passed: false,
      }
    }
  }

  private async checkSfdxProject(): Promise<ConfigCheck> {
    const projectFile = path.join(process.cwd(), 'sfdx-project.json')
    const exists = fs.pathExistsSync(projectFile)

    return {
      fix: exists ? undefined : 'Create an sfdx-project.json file with: sf project generate',
      message: exists
        ? 'sfdx-project.json found'
        : 'sfdx-project.json not found',
      name: 'Salesforce Project',
      passed: exists,
    }
  }

  private displayResults(checks: ConfigCheck[]): void {
    for (const check of checks) {
      const spinner = ora(check.name).start()

      if (check.passed) {
        spinner.succeed(chalk.dim(check.message))
      } else {
        spinner.fail(chalk.dim(check.message))
        if (check.fix) {
          this.log(`  ${chalk.cyan('→')} ${chalk.dim(check.fix)}`)
        }
      }
    }
  }
}
