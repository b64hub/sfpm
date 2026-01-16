import { Args, Command, Flags } from '@oclif/core'
import { SfpmCore, AllPackagesStrategy, SinglePackageStrategy, GitDiffStrategy, VersionBumpType, VersionUpdateResult } from '@b64/sfpm-core';
import SfpmCommand from '../../../sfpm-command.js';
import ora from 'ora';
import treeify from 'object-treeify';
import boxen from 'boxen';
import chalk from 'chalk';

export default class ProjectVersionBump extends SfpmCommand {
    public static description = 'Bump package versions in sfdx-project.json';

    static override args = {
        file: Args.string({ description: 'file to read' }),
    }
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

        // 1. Initialize Core
        const core = new SfpmCore({
            apiKey: 'unused',
            verbose: false
        });

        const versionManager = core.project.getVersionManager();
        const spinner = ora('Initializing...').start();

        // 2. Setup Events
        versionManager.on('loading', () => {
            spinner.text = 'Loading project configuration...';
        });

        versionManager.on('loaded', () => {
            spinner.succeed('Project loaded.');
            spinner.start('Analyzing packages...');
        });

        versionManager.on('checking', () => {
            spinner.text = 'Checking for updates...';
        });

        versionManager.on('checked', (result: VersionUpdateResult) => {
            spinner.succeed(`Analysis complete. Found ${result.packagesUpdated} packages to update.`);
        });

        versionManager.on('saving', () => {
            spinner.start('Saving changes...');
        });

        versionManager.on('saved', () => {
            spinner.succeed('Changes saved to project file.');
        });

        try {
            // 3. Load Project
            // We'll trust the core service initializes with default config or implemented logic
            // If specific file path needed, core service needs update or config passed
            await versionManager.load();

            // 4. Determine Strategy
            let strategy;
            if (flags.package) {
                strategy = new SinglePackageStrategy(flags.package);
            } else if (flags.targetref) {
                strategy = new GitDiffStrategy(flags.targetref);
            } else if (flags.targetorg) {
                this.warn('OrgDiffStrategy not fully implemented with real org connection yet.');
                // strategy = new OrgDiffStrategy(...);
                return;
            } else if (flags.all) {
                strategy = new AllPackagesStrategy();
            } else {
                // Default if nothing specified? Maybe warning or All
                strategy = new AllPackagesStrategy();
            }

            // 5. Determine Bump Type
            let bumpType: VersionBumpType = 'patch';
            if (flags.major) bumpType = 'major';
            if (flags.minor) bumpType = 'minor';
            if (flags.versionnumber) bumpType = 'custom';

            // 6. Check Updates
            const result = await versionManager.checkUpdates(strategy, bumpType, flags.versionnumber);

            // 7. Visualize Output
            if (result.packagesUpdated === 0) {
                this.log(boxen(chalk.green('No packages need updating.'), { padding: 1 }));
                return;
            }

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

            // 8. Save
            if (!flags.dryrun) {
                await versionManager.save();
            } else {
                this.log(boxen(chalk.yellow('DRY RUN: No changes were written to disk.'), { padding: 1, borderStyle: 'double' }));
            }

        } catch (error: any) {
            spinner.fail('Operation failed.');
            this.error(error.message);
        }
    }
}