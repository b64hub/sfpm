import {type Logger, WorkspaceInitializer} from '@b64/sfpm-core'
import {
  checkbox, confirm, input, select,
} from '@inquirer/prompts'
import {Flags} from '@oclif/core'
import chalk from 'chalk'
import fs from 'node:fs'
import path from 'node:path'
import ora from 'ora'

import SfpmCommand from '../../sfpm-command.js'

export default class InitTurbo extends SfpmCommand {
  static override description = 'Initialize a turbo-native workspace for SFPM packages'
  static override examples = [
    '<%= config.bin %> init turbo',
    '<%= config.bin %> init turbo --migrate',
    '<%= config.bin %> init turbo --migrate --npm-scope @myorg',
    '<%= config.bin %> init turbo --migrate --workspace-dir packages',
    '<%= config.bin %> init turbo --json',
  ]
  static override flags = {
    json: Flags.boolean({description: 'output result as JSON'}),
    migrate: Flags.boolean({
      char: 'm',
      description: 'migrate from an existing sfdx-project.json',
    }),
    'npm-scope': Flags.string({description: 'npm scope for package names (e.g., @myorg)'}),
    'package-manager': Flags.string({
      default: 'pnpm',
      description: 'package manager to use',
      options: ['pnpm', 'npm', 'yarn'],
    }),
    'workspace-dir': Flags.string({
      description: 'directory prefix for migrated packages (e.g., "packages")',
    }),
    yes: Flags.boolean({
      char: 'y',
      description: 'skip confirmation prompts (use defaults)',
    }),
  }

  public async execute(): Promise<void> {
    const {flags} = await this.parse(InitTurbo)
    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()

    const logger: Logger = {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }

    // Determine mode: migrate or fresh scaffold
    let shouldMigrate = flags.migrate
    const hasSfdxProject = fs.existsSync(path.join(projectDir, 'sfdx-project.json'))

    if (!flags.json && !flags.yes && hasSfdxProject && !shouldMigrate) {
      shouldMigrate = await confirm({
        default: true,
        message: 'Found existing sfdx-project.json. Migrate packages to workspace format?',
      })
    }

    // Resolve npm scope
    let npmScope = flags['npm-scope']
    if (!npmScope) {
      npmScope = this.detectNpmScope(projectDir)
    }

    if (!npmScope && !flags.json && !flags.yes) {
      npmScope = await input({
        message: 'npm scope for package names (e.g., @myorg):',
        validate(value: string) {
          if (!value.startsWith('@')) return 'Scope must start with @'
          if (!value.includes('/') && value.length < 2) return 'Scope too short'
          return true
        },
      })
    }

    if (!npmScope) {
      this.error('npm scope is required. Use --npm-scope to specify the scope for package names (e.g., --npm-scope @myorg)', {exit: 1})
    }

    // Ensure scope starts with @
    if (!npmScope.startsWith('@')) {
      npmScope = `@${npmScope}`
    }

    // Resolve package manager
    const packageManager = flags['package-manager'] as 'npm' | 'pnpm' | 'yarn'

    // Resolve workspace directory for migration
    let workspaceDir = flags['workspace-dir']
    if (shouldMigrate && !workspaceDir && !flags.json && !flags.yes) {
      const choice = await select({
        choices: [
          {description: 'Keep package directories where they are', name: 'Keep original paths', value: ''},
          {description: 'Group packages under packages/', name: 'packages/', value: 'packages'},
          {description: 'Enter a custom directory', name: 'Custom...', value: '__custom__'},
        ],
        message: 'Where should package directories live?',
      })

      if (choice === '__custom__') {
        workspaceDir = await input({message: 'Workspace directory:'})
      } else {
        workspaceDir = choice || undefined
      }
    }

    // Prompt for source directories to include in turbo build inputs (fresh scaffold only)
    let turboInputs: string[] | undefined
    if (!shouldMigrate && !flags.json && !flags.yes) {
      const topLevelDirs = this.getTopLevelDirectories(projectDir)
      if (topLevelDirs.length > 0) {
        const selected = await checkbox({
          choices: topLevelDirs.map(dir => ({
            checked: /^(force-app|src|data|main)$/i.test(dir),
            name: `${dir}/`,
            value: dir,
          })),
          message: 'Which directories contain source files for the build? (turbo cache inputs)',
          required: true,
        })

        turboInputs = [...selected.map(d => `${d}/**`), 'package.json', '.forceignore']
      }
    }

    // Show plan before executing
    if (!flags.json && !flags.yes) {
      this.log('')
      this.log(chalk.bold('  Workspace setup plan:'))
      this.log(`    Mode:            ${shouldMigrate ? chalk.cyan('migrate from sfdx-project.json') : chalk.cyan('fresh scaffold')}`)
      this.log(`    npm scope:       ${chalk.cyan(npmScope)}`)
      this.log(`    Package manager: ${chalk.cyan(packageManager)}`)
      if (workspaceDir) {
        this.log(`    Workspace dir:   ${chalk.cyan(workspaceDir)}`)
      }

      if (turboInputs) {
        this.log(`    Build inputs:    ${chalk.cyan(turboInputs.filter(i => i.endsWith('/**')).map(i => i.replace('/**', '/')).join(', '))}`)
      }

      this.log('')
      const proceed = await confirm({default: true, message: 'Proceed?'})
      if (!proceed) {
        this.log(chalk.dim('  Cancelled.\n'))
        return
      }
    }

    const spinner = flags.json ? undefined : ora('Initializing workspace...').start()

    try {
      const initializer = new WorkspaceInitializer(logger)

      const result = shouldMigrate
        ? await initializer.migrate({
          logger,
          npmScope,
          packageManager,
          projectDir,
          turboInputs,
          workspaceDir,
        })
        : await initializer.scaffold({
          logger,
          npmScope,
          packageManager,
          projectDir,
          turboInputs,
        })

      spinner?.succeed('Workspace initialized')

      if (flags.json) {
        this.logJson(result)
        return
      }

      // Display results
      if (result.created.length > 0) {
        this.log('')
        this.log(chalk.bold('  Created:'))
        for (const file of result.created) {
          this.log(`    ${chalk.green('+')} ${file}`)
        }
      }

      if (result.modified.length > 0) {
        this.log('')
        this.log(chalk.bold('  Modified:'))
        for (const file of result.modified) {
          this.log(`    ${chalk.yellow('~')} ${file}`)
        }
      }

      if (result.packages.length > 0) {
        this.log('')
        this.log(chalk.bold('  Packages:'))
        for (const pkg of result.packages) {
          this.log(`    ${chalk.cyan(pkg.name)} ${chalk.dim(`(${pkg.type})`)} ${chalk.dim(pkg.packageDir)}`)
        }
      }

      if (result.warnings.length > 0) {
        this.log('')
        this.log(chalk.yellow('  Warnings:'))
        for (const warning of result.warnings) {
          this.log(`    ${chalk.yellow('!')} ${warning}`)
        }
      }

      // Next steps
      this.log('')
      this.log(chalk.bold('  Next steps:'))
      if (packageManager === 'pnpm') {
        this.log(`    1. ${chalk.dim('pnpm install')}`)
      } else {
        this.log(`    1. ${chalk.dim(`${packageManager} install`)}`)
      }

      this.log(`    2. ${chalk.dim('sfpm sync --turbo')}         ${chalk.dim('# generate sfdx-project.json from package.json files')}`)
      this.log(`    3. ${chalk.dim('turbo run sfpm:build')}       ${chalk.dim('# build all packages')}`)
      this.log('')
    } catch (error) {
      spinner?.fail('Initialization failed')

      if (flags.json) {
        this.logJson({error: (error as Error).message, success: false})
      }

      if (error instanceof Error) {
        this.error(error.message, {exit: 1})
      }

      throw error
    }
  }

  /**
   * Try to detect npm scope from existing config sources.
   */
  private detectNpmScope(projectDir: string): string | undefined {
    // Check sfpm.config.ts/js imports (would need the config loader)
    // For now, check root package.json name
    const rootPkgPath = path.join(projectDir, 'package.json')
    if (fs.existsSync(rootPkgPath)) {
      try {
        const rootPkg = JSON.parse(fs.readFileSync(rootPkgPath, 'utf8'))
        const name = rootPkg.name as string
        if (name?.startsWith('@')) {
          const scope = name.split('/')[0]
          return scope
        }
      } catch {
        // ignore
      }
    }

    // Check .npmrc for scope
    const npmrcPath = path.join(projectDir, '.npmrc')
    if (fs.existsSync(npmrcPath)) {
      const content = fs.readFileSync(npmrcPath, 'utf8')
      const match = content.match(/@([^/:]+):registry/)
      if (match) return `@${match[1]}`
    }

    return undefined
  }

  /**
   * Get top-level directories in the project, excluding common non-source dirs.
   */
  private getTopLevelDirectories(projectDir: string): string[] {
    const EXCLUDED = new Set([
      '.git',
      '.github',
      '.husky',
      '.sf',
      '.sfdx',
      '.vscode',
      'artifacts',
      'dist',
      'node_modules',
    ])

    try {
      return fs.readdirSync(projectDir, {withFileTypes: true})
      .filter(entry => entry.isDirectory() && !EXCLUDED.has(entry.name) && !entry.name.startsWith('.'))
      .map(entry => entry.name)
      .sort()
    } catch {
      return []
    }
  }
}
