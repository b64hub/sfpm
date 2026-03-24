import {
  AllPackagesStrategy, GitDiffStrategy, GitService, OrgDiffStrategy, type OrgPackageVersionFetcher, PackageService,
  ProjectService, SfpmCore, SinglePackageStrategy, type UpdateStrategy, type VersionBumpType,
  type VersionManager, type VersionUpdateResult,
} from '@b64/sfpm-core';
import {Flags} from '@oclif/core'
import {Org} from '@salesforce/core';
import boxen from 'boxen';
import chalk from 'chalk';
import treeify from 'object-treeify';
import ora from 'ora';

import SfpmCommand from '../../../sfpm-command.js';

export default class ProjectVersionBump extends SfpmCommand {
  public static description = 'Bump package versions in sfdx-project.json';
  public static examples = [
    '$ sfp project version bump --package mypackage --minor',
    '$ sfp project version bump --all --patch',
    '$ sfp project version bump --targetref main',
    '$ sfp project version bump --targetorg myorg',
    '$ sfp project version bump --package mypackage --versionnumber 2.0.0',
    '$ sfp project version bump --package mypackage --patch --projectfile path/to/sfdx-project.json',
  ];
  public static flags = {
    all: Flags.boolean({
      char: 'a',
      description: 'Increment all package versions',
      required: false,
    }),
    dryrun: Flags.boolean({
      default: false,
      description: 'Preview changes without saving to sfdx-project.json',
      required: false,
    }),
    major: Flags.boolean({
      char: 'M',
      description: 'Increment major number',
      required: false,
    }),
    minor: Flags.boolean({
      char: 'm',
      description: 'Increment minor number',
      required: false,
    }),
    package: Flags.string({
      char: 'p',
      description: 'Specify the package to increment',
      required: false,
    }),
    patch: Flags.boolean({
      description: 'Increment patch number (default)',
      required: false,
    }),
    projectfile: Flags.string({
      char: 'f',
      default: 'sfdx-project.json',
      description: 'Path to sfdx-project.json file',
      required: false,
    }),
    targetorg: Flags.string({
      char: 'o',
      description: 'Specify the target org for diff comparison',
      required: false,
    }),
    targetref: Flags.string({
      char: 'r',
      description: 'Specify the git reference for diff comparison',
      required: false,
    }),
    versionnumber: Flags.string({
      char: 'v',
      description: 'Set a custom version number',
      required: false,
    }),
  };

  public async execute(): Promise<void> {
    const {flags} = await this.parse(ProjectVersionBump)

    // If projectfile is default or a file name (not a path), use current directory
    // Otherwise use the directory containing the projectfile
    const projectPath = flags.projectfile === 'sfdx-project.json'
      ? process.cwd()
      : flags.projectfile.includes('/')
        ? flags.projectfile.slice(0, Math.max(0, flags.projectfile.lastIndexOf('/')))
        : process.cwd();

    // 1. Initialize Core
    const core = await SfpmCore.create({
      apiKey: 'unused',
      projectPath,
      verbose: false,
    });

    const versionManager = core.project.createVersionManager();
    const spinner = ora('Initialized.').start();

    // 2. Setup Events
    versionManager.on('checking', () => {
      spinner.text = 'Checking for updates...';
    });

    versionManager.on('checked', (result: VersionUpdateResult) => {
      spinner.succeed(`Analysis complete. Found ${result.packagesUpdated} packages to update.`);
    });

    try {
      const strategy = await this.getStrategy(flags, projectPath);
      const bumpType = this.getBumpType(flags);

      const result = await versionManager.bump(bumpType, {
        strategy,
        version: flags.versionnumber,
      });
      if (result.packagesUpdated === 0) {
        this.log(boxen(chalk.green('No packages need updating.'), {padding: 1}));
        return;
      }

      this.outputResult(result);
      await this.save(core.project, versionManager, flags.dryrun);
    } catch (error: unknown) {
      spinner.fail(chalk.red('Operation failed.'));
      this.error(error instanceof Error ? error.message : String(error));
    }
  }

  private getBumpType(flags: {major?: boolean; minor?: boolean; versionnumber?: string}): VersionBumpType {
    if (flags.major) return 'major';
    if (flags.minor) return 'minor';
    if (flags.versionnumber) return 'custom';
    return 'patch';
  }

  private async getStrategy(flags: {all?: boolean; package?: string; targetorg?: string; targetref?: string}, projectPath: string): Promise<UpdateStrategy> {
    if (flags.package) {
      return new SinglePackageStrategy(flags.package);
    }

    if (flags.targetref) {
      const gitService = await GitService.initialize(projectPath);
      return new GitDiffStrategy(flags.targetref, gitService);
    }

    if (flags.targetorg) {
      const org = await Org.create({aliasOrUsername: flags.targetorg});
      const packageService = new PackageService(org);
      await packageService.preloadInstalled2GPPackages();

      const fetcher: OrgPackageVersionFetcher = {
        async getInstalledVersion(packageName: string): Promise<null | string> {
          const installed = await packageService.getAllInstalled2GPPackages();
          const match = installed.find(pkg => pkg.name === packageName);
          return match?.versionNumber ?? null;
        },
      };

      return new OrgDiffStrategy(fetcher);
    }

    if (flags.all) {
      return new AllPackagesStrategy();
    }

    return new AllPackagesStrategy();
  }

  private outputResult(result: VersionUpdateResult) {
    this.log(chalk.bold.cyan('\nUpdated Packages:'));

    for (const pkg of result.packages) {
      this.log(`${chalk.blue(pkg.name)}  ${chalk.red(pkg.oldVersion)} -> ${chalk.green(pkg.newVersion)}`);
    }

    if (result.dependencies && result.dependencies.length > 0) {
      this.log(chalk.bold.yellow('\nDependent Package Updates:'));

      const treeData: Record<string, Record<string, string>> = {};
      for (const parent of result.dependencies) {
        const depNodes: Record<string, string> = {};
        if (parent.dependencies) {
          for (const dep of parent.dependencies) {
            depNodes[dep.name] = `${chalk.green(dep.newVersion)}`;
          }
        }

        treeData[chalk.blue(parent.name)] = depNodes;
      }

      this.log(treeify(treeData));
    }
  }

  private async save(projectService: ProjectService, versionManager: VersionManager, dryrun: boolean) {
    this.log('\n');
    if (dryrun) {
      this.log(boxen(chalk.yellow('DRY RUN: No changes were written to disk.'), {borderColor: 'yellow', borderStyle: 'round', padding: 1}));
      return;
    }

    const spinner = ora('Saving...').start();
    try {
      const updatedDefinition = versionManager.getUpdatedDefinition();
      await projectService.saveProjectDefinition(updatedDefinition);
      spinner.succeed(chalk.green('Project saved successfully.'));
    } catch (error: unknown) {
      spinner.fail(chalk.red('Failed to save project.'));
      this.error(error instanceof Error ? error.message : String(error));
    }
  }
}
