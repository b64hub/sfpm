import { Args, Command, Flags } from '@oclif/core'
import { SfpmCore, AllPackagesStrategy, SinglePackageStrategy, GitDiffStrategy, VersionBumpType, VersionUpdateResult, VersionManager, UpdateStrategy } from '@b64/sfpm-core';
import SfpmCommand from '../../../sfpm-command.js';
import ora from 'ora';
import treeify from 'object-treeify';
import boxen from 'boxen';
import chalk from 'chalk';

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
        package: Flags.string({
            char: 'p',
            description: 'Specify the package to increment',
            required: false,
        }),
        all: Flags.boolean({
            char: 'a',
            description: 'Increment all package versions',
            required: false,
        }),
        targetref: Flags.string({
            char: 'r',
            description: 'Specify the git reference for diff comparison',
            required: false,
        }),
        targetorg: Flags.string({
            char: 'o',
            description: 'Specify the target org for diff comparison',
            required: false,
        }),
        patch: Flags.boolean({
            description: 'Increment patch number (default)',
            required: false,
        }),
        minor: Flags.boolean({
            char: 'm',
            description: 'Increment minor number',
            required: false,
        }),
        major: Flags.boolean({
            char: 'M',
            description: 'Increment major number',
            required: false,
        }),
        versionnumber: Flags.string({
            char: 'v',
            description: 'Set a custom version number',
            required: false,
        }),
        dryrun: Flags.boolean({
            description: 'Preview changes without saving to sfdx-project.json',
            required: false,
            default: false,
        }),
        projectfile: Flags.string({
            char: 'f',
            description: 'Path to sfdx-project.json file',
            required: false,
            default: 'sfdx-project.json',
        }),
    };

    public async execute(): Promise<void> {
        const { args, flags } = await this.parse(ProjectVersionBump)

        const projectFile = flags.projectfile;

        // 1. Initialize Core
        const core = await SfpmCore.create({
            apiKey: 'unused',
            verbose: false,
            projectPath: projectFile
        });

        const versionManager = core.project.getVersionManager();
        const spinner = ora('Initialized.').start();

        // 2. Setup Events
        versionManager.on('checking', () => {
            spinner.text = 'Checking for updates...';
        });

        versionManager.on('checked', (result: VersionUpdateResult) => {
            spinner.succeed(`Analysis complete. Found ${result.packagesUpdated} packages to update.`);
        });

        try {
            const strategy = this.getStrategy(flags);
            const bumpType = this.getBumpType(flags);

            const result = await versionManager.bump(bumpType, {
                strategy: strategy,
                version: flags.versionnumber
            });
            if (result.packagesUpdated === 0) {
                this.log(boxen(chalk.green('No packages need updating.'), { padding: 1 }));
                return;
            }

            this.outputResult(result);
            this.save(versionManager, flags.dryrun);

        } catch (error: any) {
            spinner.fail(chalk.red('Operation failed.'));
            this.error(error.message);
        }
    }

    private getBumpType(flags: any): VersionBumpType {
        if (flags.major) return 'major';
        if (flags.minor) return 'minor';
        if (flags.versionnumber) return 'custom';
        return 'patch';
    }

    private getStrategy(flags: any): UpdateStrategy {
        if (flags.package) {
            return new SinglePackageStrategy(flags.package);
        } else if (flags.targetref) {
            return new GitDiffStrategy(flags.targetref);
        } else if (flags.targetorg) {
            this.warn('OrgDiffStrategy not fully implemented with real org connection yet.');
            // strategy = new OrgDiffStrategy(...);
            return new AllPackagesStrategy();
        } else if (flags.all) {
            return new AllPackagesStrategy();
        } else {
            // Default if nothing specified? Maybe warning or All
            return new AllPackagesStrategy();
        }
    }

    private outputResult(result: VersionUpdateResult) {
        this.log(chalk.bold.cyan('\nUpdated Packages:'));

        // Custom format: <package-name> <old> -> <new>
        result.packages.forEach((pkg: any) => {
            this.log(`${chalk.blue(pkg.name)}  ${chalk.red(pkg.oldVersion)} -> ${chalk.green(pkg.newVersion)}`);
        });

        if (result.dependencies && result.dependencies.length > 0) {
            this.log(chalk.bold.yellow('\nDependent Package Updates:'));

            // Format: <parent> - <dep> <old> -> <new>
            const treeData: Record<string, any> = {};
            result.dependencies.forEach((p: any) => {
                const depNodes: Record<string, string> = {};
                p.dependencies?.forEach((d: any) => {
                    // We don't have old version for deps easily available effectively in current output structure
                    // Assuming d.oldVersion might be '?' or we just show new
                    depNodes[d.name] = `${chalk.green(d.newVersion)}`;
                });
                treeData[chalk.blue(p.name)] = depNodes;
            });
            this.log(treeify(treeData));
        }
    }

    private async save(versionManager: VersionManager, dryrun: boolean) {
        this.log('\n');
        if (dryrun) {
            this.log(boxen(chalk.yellow('DRY RUN: No changes were written to disk.'), { padding: 1, borderColor: 'yellow', borderStyle: 'round' }));
            return;
        }

        const spinner = ora('Saving...').start();
        try {
            await versionManager.save();
            spinner.succeed(chalk.green('Project saved successfully.'));
        } catch (error: any) {
            spinner.fail(chalk.red('Failed to save project.'));
            this.error(error.message);
        }
    }
}