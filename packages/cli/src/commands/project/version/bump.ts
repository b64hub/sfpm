import {Args, Command, Flags} from '@oclif/core'
import { SfpCore } from '@b64/sfp-core';
import SfpmCommand from '../../../sfpm-command.js';
import ora from 'ora';

export default class ProjectVersionBump extends SfpmCommand {
  public static description = 'Bump package versions in sfdx-project.json';

  static override args = {
    file: Args.string({description: 'file to read'}),
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
    const {args, flags} = await this.parse(ProjectVersionBump)

    // 1. Initialize your Core engine
    const core = new SfpCore({ 
      apiKey: 'your-api-key', 
      verbose: true 
    });

    // 2. Access the service you just added
    const spinner = ora('Fetching project configurations...').start();
    const projects = await core.project.getConfig(); 
    spinner.succeed('Project configurations fetched.');
    
    this.log(`Found ${projects.length} projects.`);
  }
}








    // public write(): PackageOutput {
    //     const output: PackageOutput = { package: this.packageName };

    //     // If no current version, this is likely an alias reference - don't include versionNumber
    //     if (this.currentVersion === null || this.currentVersion === undefined) {
    //         if (this.dependencies.length > 0) {
    //             output.dependencies = this.dependencies.map((dep) => dep.write());
    //         }
    //         return output;
    //     }

    //     output.versionNumber = this.currentVersion;

    //     if (this.isUpdated) {
    //         output.versionNumber = this.newVersion;
    //     }

    //     if (this.dependencies.length > 0) {
    //         output.dependencies = this.dependencies.map((dep) => dep.write());
    //     }

    //     return output;
    // }

    // public print(options: { includeName?: boolean; nameWidth?: number; highlightFn?: typeof chalk.yellow.bold } = {}): string {
    //     const { includeName = false, nameWidth = 30, highlightFn = chalk.yellow.bold } = options;
        
    //     let output = '';
        
    //     if (includeName) {
    //         output = this.packageName.padEnd(nameWidth) + ' ';
    //     }

    //     if (!this.isUpdated) {
    //         const currentVersion = this.formatVersion(this.currentVersion);
    //         return output + currentVersion;
    //     }

    //     const oldParts = this.versionByParts();
    //     const newParts = this.versionByParts(this.newVersion);

    //     const formattedOld: string = oldParts
    //         .map((part, index) => {
    //             return part !== newParts[index] ? highlightFn(part) : part;
    //         })
    //         .join('.');
    //     const formattedNew: string = this.versionByParts(this.newVersion)
    //         .map((part, index) => {
    //             return part === oldParts[index] ? part : highlightFn(part);
    //         })
    //         .join('.');

    //     const versionWidth = includeName ? 12 : 0;
    //     return output + formattedOld.padEnd(versionWidth) + ' → ' + formattedNew;
    // }