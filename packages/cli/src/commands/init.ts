import { Flags } from '@oclif/core'
import SfpmCommand from '../sfpm-command.js'
import { ProjectService, Git } from '@b64/sfpm-core'
import chalk from 'chalk'
import path from 'path'
import fs from 'fs-extra'
import ora from 'ora'

interface ConfigCheck {
  name: string
  passed: boolean
  message: string
  fix?: string
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
      description: 'Attempt to fix issues automatically',
      default: false,
    }),
  }

  public async execute(): Promise<void> {
    const { flags } = await this.parse(Init)

    this.log(chalk.bold('\nChecking SFPM Project Configuration\n'))

    const checks: ConfigCheck[] = []

    // Check 1: sfdx-project.json exists
    checks.push(await this.checkSfdxProject())

    // Check 2: Git repository initialized
    checks.push(await this.checkGitRepo())

    // Check 3: Git remote configured
    checks.push(await this.checkGitRemote())

    // Check 4: Package directories configured
    checks.push(await this.checkPackageDirectories())

    // Display results
    this.displayResults(checks)

    // Attempt fixes if requested
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

  private async checkSfdxProject(): Promise<ConfigCheck> {
    const projectFile = path.join(process.cwd(), 'sfdx-project.json')
    const exists = fs.pathExistsSync(projectFile)

    return {
      name: 'Salesforce Project',
      passed: exists,
      message: exists
        ? 'sfdx-project.json found'
        : 'sfdx-project.json not found',
      fix: exists ? undefined : 'Create an sfdx-project.json file with: sf project generate',
    }
  }

  private async checkGitRepo(): Promise<ConfigCheck> {
    const gitDir = path.join(process.cwd(), '.git')
    const exists = fs.pathExistsSync(gitDir)

    return {
      name: 'Git Repository',
      passed: exists,
      message: exists ? 'Git repository initialized' : 'Not a git repository',
      fix: exists ? undefined : 'Initialize git with: git init',
    }
  }

  private async checkGitRemote(): Promise<ConfigCheck> {
    try {
      // Check if .git exists first
      const gitDir = path.join(process.cwd(), '.git')
      const isRepo = await fs.pathExists(gitDir)
      
      if (!isRepo) {
        return {
          name: 'Git Remote',
          passed: false,
          message: 'Not a git repository',
          fix: 'Initialize git first with: git init',
        }
      }

      const git = new Git(process.cwd())
      const remoteUrl = await git.getRemoteOriginUrl()

      return {
        name: 'Git Remote',
        passed: !!remoteUrl,
        message: remoteUrl
          ? `Remote origin: ${remoteUrl}`
          : 'No remote origin configured',
        fix: remoteUrl
          ? undefined
          : 'Add remote with: git remote add origin <repository-url>',
      }
    } catch (error) {
      return {
        name: 'Git Remote',
        passed: false,
        message: 'No remote origin configured',
        fix: 'Add remote with: git remote add origin <repository-url>',
      }
    }
  }

  private async checkPackageDirectories(): Promise<ConfigCheck> {
    try {
      const projectService = await ProjectService.getInstance(process.cwd())
      const config = projectService.getProjectConfig()
      const packages = config.getAllPackageNames()

      return {
        name: 'Package Directories',
        passed: packages.length > 0,
        message: packages.length > 0
          ? `Found ${packages.length} package(s): ${packages.join(', ')}`
          : 'No packages defined in sfdx-project.json',
        fix: packages.length > 0
          ? undefined
          : 'Add packages with: sf package create',
      }
    } catch (error) {
      return {
        name: 'Package Directories',
        passed: false,
        message: 'Could not read project configuration',
        fix: 'Ensure sfdx-project.json is valid',
      }
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
}
