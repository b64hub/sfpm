import { PackageType } from '../types/package.js';
import { ProjectDefinition, ProjectFileReader, PackageDefinition, PackageDependency } from './types.js';

export interface ExternalPackage {
    alias: string;
    packageId: string;
}

/**
 * Helper functions for retrieving info from project config
 */
export default class ProjectConfig {
    private fileReader: ProjectFileReader;
    private project: ProjectDefinition | undefined;

    constructor(fileReader: ProjectFileReader) {
        this.fileReader = fileReader;
    }

    /**
     * Loads the project configuration if not already loaded
     */
    public async load(): Promise<void> {
        if (this.project) {
            return;
        }
        this.project = await this.fileReader.read();
    }

    /**
     * Returns 0H Id of package from project config
     * @param name Package name
     */
    public async getPackageId(name: string): Promise<string> {
        await this.load();

        const packageId = this.project?.packageAliases?.[name];
        if (packageId) {
            return packageId;
        }

        throw new Error(
            `No Package Id found for '${name}' in sfdx-project.json. Please ensure package alias is added.`
        );
    }

    /**
     * Returns all package names defined in the project
     */
    public async getAllPackages(): Promise<string[]> {
        await this.load();

        if (!this.project?.packageDirectories) {
            return [];
        }

        return this.project.packageDirectories
            .filter((pkg) => pkg.package && pkg.versionNumber)
            .map((pkg) => pkg.package);
    }

    /**
     * Returns all external packages (defined in aliases but not in packageDirectories)
     */
    public async getExternalPackages(): Promise<ExternalPackage[]> {
        await this.load();

        if (!this.project?.packageAliases) {
            return [];
        }

        const internalPackageNames = new Set(
            this.project.packageDirectories.map((pkg) => pkg.package)
        );

        return Object.entries(this.project.packageAliases)
            .filter(([alias]) => !internalPackageNames.has(alias))
            .map(([alias, packageId]) => ({
                alias,
                packageId,
            }));
    }

    /**
     * Returns a map of package names to their dependencies
     */
    public async getDependencyMap(): Promise<Map<string, PackageDependency[]>> {
        await this.load();

        const dependencyMap = new Map<string, PackageDependency[]>();

        if (!this.project?.packageDirectories) {
            return dependencyMap;
        }

        for (const pkg of this.project.packageDirectories) {
            if (pkg.dependencies) {
                dependencyMap.set(pkg.package, pkg.dependencies);
            }
        }

        return dependencyMap;
    }

    /**
     * Returns the type of a package
     * @param name Package name
     */
    public async getPackageType(name: string): Promise<PackageType> {
        const descriptor = await this.getPackageDescriptor(name);
        await this.load();

        // If it's in aliases, it's Unlocked
        if (this.project?.packageAliases?.[name]) {
            return PackageType.Unlocked;
        }

        // Check explicit type or default to Source
        const type = descriptor.type?.toString().toLowerCase();
        if (type === PackageType.Data) return PackageType.Data;
        if (type === PackageType.Diff) return PackageType.Diff;

        return PackageType.Source;
    }

    /**
     * Returns the package descriptor (definition) for a given package name
     * @param name Package name
     */
    public async getPackageDescriptor(name: string): Promise<PackageDefinition> {
        await this.load();

        const descriptor = this.project?.packageDirectories.find(
            (pkg) => pkg.package === name
        );

        if (!descriptor) {
            throw new Error(`Package '${name}' does not exist in sfdx-project.json`);
        }

        return descriptor;
    }

    /**
     * Returns the default package descriptor
     */
    public async getDefaultPackageDescriptor(): Promise<PackageDefinition> {
        await this.load();

        const descriptor = this.project?.packageDirectories.find(
            (pkg) => pkg.default === true
        );

        if (!descriptor) {
            throw new Error('No default package found in sfdx-project.json');
        }

        return descriptor;
    }

    /**
     * Returns a pruned ProjectDefinition containing only the specified packages
     * @param packageNames Names of packages to keep
     */
    public async filterPackages(packageNames: string[]): Promise<ProjectDefinition> {
        await this.load();

        if (!this.project) {
            throw new Error('Project configuration not loaded');
        }

        const filteredDirectories = this.project.packageDirectories.filter((pkg) =>
            packageNames.includes(pkg.package)
        );

        if (filteredDirectories.length > 0) {
            filteredDirectories[0].default = true;
        }

        return {
            ...this.project,
            packageDirectories: filteredDirectories,
        };
    }

    /**
     * Updates dependencies for packages in the project config
     * @param dependencyMap Map of package names to dependencies
     */
    public async updateDependencies(
        dependencyMap: Map<string, PackageDependency[]>
    ): Promise<ProjectDefinition> {
        await this.load();

        if (!this.project) {
            throw new Error('Project configuration not loaded');
        }

        const updatedDirectories = this.project.packageDirectories.map((pkg) => ({
            ...pkg,
            dependencies: dependencyMap.get(pkg.package) || pkg.dependencies,
        }));

        // Sort based on dependency map order if provided
        const sortedPackageNames = Array.from(dependencyMap.keys());
        if (sortedPackageNames.length > 0) {
            updatedDirectories.sort((a, b) => {
                const indexA = sortedPackageNames.indexOf(a.package);
                const indexB = sortedPackageNames.indexOf(b.package);
                if (indexA === -1 || indexB === -1) return 0;
                return indexA - indexB;
            });
        }

        return {
            ...this.project,
            packageDirectories: updatedDirectories,
        };
    }

    /**
     * Get the current project definition
     */
    public async getProjectDefinition(): Promise<ProjectDefinition> {
        await this.load();
        if (!this.project) {
            throw new Error('Project configuration not loaded');
        }
        return this.project;
    }
}
