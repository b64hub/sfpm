import {Args, Command, Flags} from '@oclif/core'

export default class ProjectVersionBump extends Command {
  static override args = {
    file: Args.string({description: 'file to read'}),
  }
  static override description = 'describe the command here'
  static override examples = [
    '<%= config.bin %> <%= command.id %>',
  ]
  static override flags = {
    // flag with no value (-f, --force)
    force: Flags.boolean({char: 'f'}),
    // flag with a value (-n, --name=VALUE)
    name: Flags.string({char: 'n', description: 'name to print'}),
  }

  public async run(): Promise<void> {
    const {args, flags} = await this.parse(ProjectVersionBump)

    const name = flags.name ?? 'world'
    this.log(`hello ${name} from /workspaces/sfp/packages/cli/src/commands/project/version/bump.ts`)
    if (args.file && flags.force) {
      this.log(`you input --force and --file: ${args.file}`)
    }
  }
}



interface PackageOutput {
    package: string;
    versionNumber?: string;
    dependencies?: PackageOutput[];
}

interface PackageVersion {
    name: string;
    oldVersion: string;
    newVersion: string;
}

interface PackageWithDependencies extends PackageVersion {
    dependencies: PackageVersion[];
}

interface VersionBumpResult {
    packagesUpdated: number;
    packages: PackageVersion[];
    dependencies?: PackageWithDependencies[];
}

export default class VersionUpdater extends SfpCommand {
    public static description = 'Bump package versions in sfdx-project.json';

    public static examples = [
        '$ sfp project version bump --package mypackage --minor',
        '$ sfp project version bump --all --patch',
        '$ sfp project version bump --targetref main',
        '$ sfp project version bump --targetorg myorg',
        '$ sfp project version bump --package mypackage --versionnumber 2.0.0',
        '$ sfp project version bump --package mypackage --patch --projectfile path/to/sfdx-project.json',
    ];

    public static enableJsonFlag = true;

    protected static requiresUsername = false;
    protected static requiresDevhubUsername = false;
    protected static requiresProject = true;

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
        logsgroupsymbol,
        loglevel,
    };

    projectData: {
        packageDirectories: PackageOutput[];
        [key: string]: unknown;
    };
    projectPackages: Map<string, VersionedPackage>;

    diffChecker: PackageUpdater;

    async execute(): Promise<VersionBumpResult> {

        const tags: Record<string, string> = {
            versionType: this.getVersionType(),
            dryRun: String(this.flags.dryrun),
        };

        try {
            this.validateFlags();

            spinner?.start('Loading project configuration...');
            this.loadProjectData();
            spinner?.succeed('Project configuration loaded');

            spinner?.start('Analyzing packages...');
            const { updatedPackages, updatedDependencies } = await this.updateVersions();
            spinner?.stop();

            // Display results
            if (!this.flags.json) {
                this.displayResults(updatedPackages, updatedDependencies);
            }

            if (!this.flags.dryrun && updatedPackages.length > 0) {
                if (!this.flags.json) {
                    logger.log(''); // Add blank line before success message
                    spinner.start('Saving changes to sfdx-project.json...');
                }
                await this.save();
                spinner?.succeed(colorSuccess('sfdx-project.json updated successfully!\n'));
            } else if (this.flags.dryrun && updatedPackages.length > 0) {
                logger.info(colorKeyMessage('\n[Dry Run] Changes previewed but not saved.'));
            }

            // Track metrics
            const elapsedTime = Date.now() - startTime;
            const packagesUpdatedCounter = telemetry.createCounter(
                'project.version.bump.packages',
                'Number of packages updated'
            );
            packagesUpdatedCounter.add(updatedPackages.length, tags);

            const durationHistogram = telemetry.createHistogram(
                'project.version.bump.duration',
                'Duration of version bump operation'
            );
            durationHistogram.record(elapsedTime / 1000, tags);

            logger.debug(`Version bump completed in ${elapsedTime}ms`);

            // Return structured data for --json flag
            const result: VersionBumpResult = {
                packagesUpdated: updatedPackages.length,
                packages: updatedPackages.map((pkg) => ({
                    name: pkg.packageName,
                    oldVersion: pkg.currentVersion,
                    newVersion: pkg.newVersion,
                })),
            };

            if (updatedDependencies.length > 0) {
                result.dependencies = updatedDependencies.map((pkg) => ({
                    name: pkg.packageName,
                    oldVersion: pkg.currentVersion,
                    newVersion: pkg.newVersion,
                    dependencies: pkg.dependencies
                        .filter((dep) => dep.isUpdated)
                        .map((dep) => ({
                            name: dep.packageName,
                            oldVersion: dep.currentVersion,
                            newVersion: dep.newVersion,
                        })),
                }));
            }

            return result;
        } catch (error) {
            spinner?.fail((error as Error).message);

            const errorCounter = telemetry.createCounter('project.version.bump.error', 'Version bump errors');
            errorCounter.add(1, { ...tags, error: (error as Error).message });

            logger.error(`Version bump failed: ${(error as Error).message}`);
            throw error;
        }
    }

    private displayResults(updatedPackages: VersionedPackage[], updatedDependencies: VersionedPackage[]): void {
        if (updatedPackages.length === 0) {
            logger.info(colorKeyMessage('\nNo package versions to update.'));
            return;
        }

        logger.log('\n' + colorKeyMessage('Package versions updated:'));

        updatedPackages.forEach((pkg) => {
            logger.log(`  ${pkg.print({ includeName: true, nameWidth: 30 })}`);
        });

        if (updatedDependencies.length > 0) {
            logger.log('\n' + colorKeyMessage('Dependencies updated:'));

            updatedDependencies.forEach((pkg) => {
                // Only show the package if it or its dependencies were actually updated
                if (!pkg.isUpdated && !pkg.dependencies.some((dep) => dep.isUpdated)) {
                    return;
                }

                if (pkg.isUpdated) {
                    logger.log(`\n${chalk.bold(pkg.packageName)}: ${pkg.print()}`);
                } else {
                    logger.log(`\n${chalk.bold(pkg.packageName)}`);
                }

                const updatedDeps = pkg.dependencies.filter((dep) => dep.isUpdated);
                if (updatedDeps.length > 0) {
                    updatedDeps.forEach((dep, index, array) => {
                        const isLast = index === array.length - 1;
                        const prefix = isLast ? '└─' : '├─';
                        logger.log(`  ${chalk.dim(prefix)} ${dep.packageName}: ${dep.print()}`);
                    });
                }
            });
        }
    }

    protected validateFlags(): void {
        // Ensure only one update strategy is specified
        const strategies = [this.flags.package, this.flags.all, this.flags.targetref, this.flags.targetorg].filter(
            Boolean
        );
        if (strategies.length === 0) {
            throw new Error('Please specify one of: --package, --all, --targetref, or --targetorg');
        }
        if (strategies.length > 1) {
            throw new Error('Please specify only one of: --package, --all, --targetref, or --targetorg');
        }

        // Ensure only one version type is specified
        const versionTypes = [this.flags.patch, this.flags.minor, this.flags.major, this.flags.versionnumber].filter(
            Boolean
        );
        if (versionTypes.length > 1) {
            throw new Error('Please specify only one version type: --patch, --minor, --major, or --versionnumber');
        }
    }

    getVersionType(): CustomReleaseType {
        if (this.flags.minor) {
            return 'minor';
        }

        if (this.flags.major) {
            return 'major';
        }

        if (this.flags.versionnumber) {
            return 'custom';
        }

        return 'patch';
    }

    loadProjectData() {
        const projectPath = this.flags.projectfile === 'sfdx-project.json' ? null : this.flags.projectfile;
        this.projectData = ProjectConfig.getSFDXProjectConfig(projectPath);

        this.projectPackages = new Map(
            this.projectData.packageDirectories.map(
                (pkg: {
                    package: string;
                    versionNumber: string;
                    dependencies?: { package: string; versionNumber: string }[];
                    path?: string;
                }) => [pkg.package, new VersionedPackage(pkg)]
            )
        );
    }

    private async updateVersions(): Promise<{
        updatedPackages: VersionedPackage[];
        updatedDependencies: VersionedPackage[];
    }> {
        const updatedPackages = await this.getDiffChecker().getUpdatedPackages(
            this.getVersionType(),
            this.flags.versionnumber
        );

        const updatedDependencies = this.updateDependencies(updatedPackages);

        return { updatedPackages, updatedDependencies };
    }

    public getDiffChecker(): PackageUpdater {
        let diffChecker: PackageUpdater = null;

        if (this.flags.targetref) {
            diffChecker = new GitDiff(this.flags.targetref, Array.from(this.projectPackages.values()));
        } else if (this.flags.targetorg) {
            diffChecker = new OrgDiff(this.flags.targetorg, Array.from(this.projectPackages.values()));
        } else if (this.flags.package) {
            diffChecker = new SinglePackageUpdate(this.flags.package, Array.from(this.projectPackages.values()));
        } else if (this.flags.all) {
            diffChecker = new AllPackageUpdate(Array.from(this.projectPackages.values()));
        }

        if (!diffChecker) {
            throw new Error('Please specify --package, --all, --targetref, or --targetorg.');
        }

        return diffChecker;
    }

    // Get package by name
    public getPackage(packageName: string): VersionedPackage {
        return this.projectPackages.get(packageName);
    }

    /**
     * Update dependencies based on updated packages
     *
     * @param updatedPackages List of updated packages
     */
    public updateDependencies(updatedPackages: VersionedPackage[]): VersionedPackage[] {
        const updatedDependencies: VersionedPackage[] = [];

        for (const updatedPackage of updatedPackages) {
            this.projectPackages.forEach((projectPackage) => {
                const dependency = projectPackage.updateDependency(updatedPackage);

                if (dependency === null) {
                    return;
                }

                updatedDependencies.push(projectPackage);
            });
        }

        return updatedDependencies;
    }

    public async save() {
        const projectPackages = Array.from(this.projectPackages.values());

        this.projectData.packageDirectories = this.projectData.packageDirectories.map((pkg) => {
            const updatedPkg = projectPackages.find((projectPackage) => projectPackage.packageName === pkg.package);
            return updatedPkg ? { ...pkg, ...updatedPkg.write() } : pkg;
        });

        fs.writeFileSync(this.flags.projectfile, JSON.stringify(this.projectData, null, 2));
    }
}



