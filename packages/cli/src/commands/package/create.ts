import {
  loadSfpmConfig,
  Logger,
  PackageCreator,
  PackageType,
  ProjectService,
  type SfpmPackageConfig,
  type WorkspacePackageJson,
  WorkspaceSync,
} from '@b64hub/sfpm-core'
import {confirm, input, select} from '@inquirer/prompts'
import {Flags} from '@oclif/core'
import {Org} from '@salesforce/core'
import chalk from 'chalk'
import fs from 'fs-extra'
import path from 'node:path'
import ora from 'ora'

import SfpmCommand from '../../sfpm-command.js'
import {infoBox, successBox} from '../../ui/boxes.js'

interface PackageCreateResult {
  created: boolean;
  packageId?: string;
  packageName: string;
  packagePath: string;
  packageType: string;
}

export default class PackageCreate extends SfpmCommand {
  static override description = 'Create a new SFPM package with interactive scaffolding'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --name my-package --type unlocked --devhub my-devhub',
    '<%= config.bin %> <%= command.id %> --name my-package --type source',
    '<%= config.bin %> <%= command.id %> --json',
  ]
  static override flags = {
    devhub: Flags.string({char: 'd', description: 'DevHub org username (required for unlocked packages)'}),
    json: Flags.boolean({description: 'output as JSON for CI/CD'}),
    name: Flags.string({char: 'n', description: 'package name (without npm scope)'}),
    'org-dependent': Flags.boolean({description: 'create as org-dependent unlocked package'}),
    path: Flags.string({char: 'p', description: 'SF source path within the package directory (default: ".")'}),
    scope: Flags.string({char: 's', description: 'npm scope for the package (e.g., "@myorg")'}),
    type: Flags.string({
      char: 't',
      description: 'package type',
      options: ['unlocked', 'source', 'data'],
    }),
  }

  public async execute(): Promise<PackageCreateResult | void> {
    const {flags} = await this.parse(PackageCreate)

    const isInteractive = !flags.json

    const logger = this.createLogger()

    const packageName = await this.resolvePackageName(flags.name, isInteractive)
    const packageType = await this.resolvePackageType(flags.type as PackageType | undefined, isInteractive)
    const sourcePath = await this.resolveSourcePath(flags.path, isInteractive)
    const isOrgDependent = await this.resolveOrgDependent(flags['org-dependent'], packageType, isInteractive)
    const npmScope = await this.resolveNpmScope(flags.scope, isInteractive)

    const projectDir = process.env.SFPM_PROJECT_DIR || process.cwd()
    const projectService = await ProjectService.getInstance(projectDir)
    const provider = projectService.getDefinitionProvider()

    const npmName = npmScope ? `${npmScope}/${packageName}` : packageName
    const packageDir = path.join(provider.projectDir, packageName)

    // Validate the package doesn't already exist
    const existingNames = provider.getAllPackageNames()
    if (existingNames.includes(packageName)) {
      this.error(`Package '${packageName}' already exists in the project.`)
    }

    if (await fs.pathExists(packageDir)) {
      this.error(`Directory '${packageName}' already exists at ${packageDir}.`)
    }

    if (isInteractive) {
      this.log(infoBox('New Package', {
        Name: npmName,
        'Org-Dependent': isOrgDependent ? 'Yes' : 'No',
        Path: sourcePath === '.' ? packageName : `${packageName}/${sourcePath}`,
        Type: packageType,
      }))
    }

    // For unlocked packages, optionally create the Package2 container in DevHub
    let packageId: string | undefined
    if (packageType === PackageType.Unlocked) {
      packageId = await this.createPackage2Container(packageName, isOrgDependent, flags.devhub, isInteractive, logger)
    }

    // Scaffold the package directory and package.json
    await this.scaffoldPackage(packageDir, {
      isOrgDependent,
      npmName,
      packageId,
      packageName,
      packageType,
      sourcePath,
    })

    // Sync sfdx-project.json so the new package is immediately visible
    await this.syncProject(projectDir, logger, isInteractive)

    const result: PackageCreateResult = {
      created: true,
      packageId,
      packageName,
      packagePath: packageName,
      packageType,
    }

    if (flags.json) {
      this.logJson(result)
      return result
    }

    this.log(successBox('Package Created', {
      Directory: packageName,
      Name: npmName,
      ...(packageId ? {'Package ID': packageId} : {}),
      Type: packageType,
    }))

    this.log(chalk.dim('\nNext steps:'))
    this.log(chalk.dim(`  1. Add your metadata to ${sourcePath === '.' ? packageName : `${packageName}/${sourcePath}`}/`))
    this.log(chalk.dim('  2. Run \'pnpm install\' to update workspace references'))
    if (packageType === PackageType.Unlocked && !packageId) {
      this.log(chalk.dim(`  3. Set sfpm.packageId in ${packageName}/package.json after creating the Package2 in your DevHub`))
    }

    return result
  }

  // ====================================================================
  // Private helpers
  // ====================================================================

  private createLogger(): Logger {
    return {
      debug: (msg: string) => this.debug(msg),
      error: (msg: string) => this.error(msg),
      info: (msg: string) => this.debug(msg),
      log: (msg: string) => this.log(msg),
      trace: (msg: string) => this.debug(msg),
      warn: (msg: string) => this.warn(msg),
    }
  }

  private async createPackage2Container(
    packageName: string,
    isOrgDependent: boolean,
    devhubFlag: string | undefined,
    isInteractive: boolean,
    logger: Logger,
  ): Promise<string | undefined> {
    let shouldCreate = false

    if (devhubFlag) {
      shouldCreate = true
    } else if (isInteractive) {
      shouldCreate = await confirm({
        default: false,
        message: 'Create the Package2 container in a DevHub now?',
      })
    }

    if (!shouldCreate) return

    const devhubUsername = devhubFlag ?? await input({
      message: 'DevHub org username or alias:',
      validate: (val: string) => val.trim().length > 0 || 'Username is required',
    })

    const spinner = isInteractive ? ora(`Creating package in ${devhubUsername}...`).start() : undefined

    try {
      const org = await Org.create({aliasOrUsername: devhubUsername})
      const creator = new PackageCreator(org, logger)
      const packageId = await creator.createPackage(
        {
          description: '',
          isOrgDependent,
          name: packageName,
          path: packageName,
        },
        process.cwd(),
      )

      spinner?.succeed(`Package created in DevHub (${packageId})`)
      return packageId
    } catch (error) {
      spinner?.fail('Failed to create Package2 in DevHub')

      if (isInteractive) {
        this.warn(`Could not create Package2: ${error instanceof Error ? error.message : String(error)}`)
        this.log(chalk.dim('You can set sfpm.packageId manually later.'))
        return
      }

      throw error
    }
  }

  private async resolveNpmScope(flagValue: string | undefined, isInteractive: boolean): Promise<string | undefined> {
    if (flagValue) return flagValue.startsWith('@') ? flagValue : `@${flagValue}`

    if (!isInteractive) return

    const value = await input({
      message: 'npm scope (e.g., @myorg — leave empty for none):',
    })

    const trimmed = value.trim()
    if (!trimmed) return
    return trimmed.startsWith('@') ? trimmed : `@${trimmed}`
  }

  private async resolveOrgDependent(flagValue: boolean | undefined, packageType: string, isInteractive: boolean): Promise<boolean> {
    if (packageType !== PackageType.Unlocked) return false
    if (flagValue !== undefined) return flagValue

    if (!isInteractive) return false

    return confirm({
      default: false,
      message: 'Make this an org-dependent unlocked package?',
    })
  }

  private async resolvePackageName(flagValue: string | undefined, isInteractive: boolean): Promise<string> {
    if (flagValue) return flagValue

    if (!isInteractive) {
      this.error('--name is required in non-interactive mode')
    }

    return input({
      message: 'Package name (without npm scope):',
      validate(val: string) {
        const trimmed = val.trim()
        if (trimmed.length === 0) return 'Package name is required'
        if (trimmed.startsWith('@')) return 'Enter the name without the npm scope (e.g., "my-package" not "@scope/my-package")'
        if (!/^[\w][\w.-]*$/.test(trimmed)) return 'Package name must start with a letter/number and contain only letters, numbers, hyphens, dots, or underscores'
        return true
      },
    })
  }

  private async resolvePackageType(flagValue: PackageType | undefined, isInteractive: boolean): Promise<PackageType> {
    if (flagValue) return flagValue

    if (!isInteractive) return PackageType.Unlocked

    return select<PackageType>({
      choices: [
        {description: '2GP unlocked package -- versioned, installable across orgs', name: 'Unlocked', value: PackageType.Unlocked},
        {description: 'Source-tracked metadata -- deployed via source push/deploy', name: 'Source', value: PackageType.Source},
        {description: 'Data package -- seed/reference data loaded via SFDMU', name: 'Data', value: PackageType.Data},
      ],
      message: 'Package type:',
    })
  }

  private async resolveSourcePath(flagValue: string | undefined, isInteractive: boolean): Promise<string> {
    if (flagValue) return flagValue

    if (!isInteractive) return '.'

    return select<string>({
      choices: [
        {description: 'Metadata lives at the package root', name: '. (root)', value: '.'},
        {description: 'Standard Salesforce project layout', name: 'force-app', value: 'force-app'},
        {name: 'Custom path...', value: '__custom__'},
      ],
      message: 'Source path within the package:',
    }).then(async val => {
      if (val === '__custom__') {
        return input({
          message: 'Custom source path:',
          validate: (v: string) => v.trim().length > 0 || 'Path is required',
        })
      }

      return val
    })
  }

  private async scaffoldPackage(packageDir: string, options: {
    isOrgDependent: boolean;
    npmName: string;
    packageId?: string;
    packageName: string;
    packageType: PackageType;
    sourcePath: string;
  }): Promise<void> {
    const sfpm: SfpmPackageConfig = {
      packageType: options.packageType as Exclude<PackageType, 'managed'>,
      ...(options.sourcePath === '.' ? {} : {path: options.sourcePath}),
      ...(options.packageId ? {packageId: options.packageId} : {}),
      ...(options.isOrgDependent ? {isOrgDependent: true} : {}),
    }

    const pkgJson: WorkspacePackageJson = {
      name: options.npmName,
      private: true,
      sfpm,
      version: '1.0.0',
    }

    // Create the package directory and source path
    const sourceDir = options.sourcePath === '.'
      ? packageDir
      : path.join(packageDir, options.sourcePath)

    await fs.ensureDir(sourceDir)

    // Write package.json
    await fs.writeJson(path.join(packageDir, 'package.json'), pkgJson, {spaces: 2})
  }

  private async syncProject(projectDir: string, logger: Logger, isInteractive: boolean): Promise<void> {
    const spinner = isInteractive ? ora('Syncing sfdx-project.json...').start() : undefined

    try {
      const sfpmConfig = await loadSfpmConfig(projectDir, logger)

      const sync = new WorkspaceSync({
        logger,
        namespace: sfpmConfig.namespace,
        projectDir,
        sfdcLoginUrl: sfpmConfig.sfdcLoginUrl,
        sourceApiVersion: sfpmConfig.sourceApiVersion,
        sourceBehaviorOptions: sfpmConfig.sourceBehaviorOptions,
      })

      await sync.run()
      spinner?.succeed('Synced sfdx-project.json')
    } catch (error) {
      spinner?.fail('Failed to sync sfdx-project.json')
      this.warn(`Sync failed: ${error instanceof Error ? error.message : String(error)}. Run 'sfpm project sync' manually.`)
    }
  }
}
