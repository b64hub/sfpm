import { SfProject, SfProjectJson, ProjectJsonSchema, ProjectJson, Logger } from '@salesforce/core';
import { ProjectDefinition, PackageDefinition, ProjectDefinitionSchema } from '../types/project.js';
import { PackageType } from '../types/package.js';



/**
 * Configuration manager for sfdx-project.json
 */
export default class ProjectConfig {
    private project: SfProject;
    private logger: Logger;
    private hasValidated = false;

    constructor(project: SfProject) {
        this.project = project;
        this.logger = Logger.childFromRoot('ProjectConfig');
    }

    /**
     * Validates custom SFPM properties (runs once, logs warnings only).
     * This is called automatically by getProjectDefinition().
     */
    private validateCustomProperties(): void {
        if (this.hasValidated) return;
        
        const rawContents = this.project.getSfProjectJson().getContents();
        const result = ProjectDefinitionSchema.safeParse(rawContents);
        
        if (!result.success) {
            this.logger.warn('SFPM custom properties validation failed:');
            const zodError = result.error;
            if (zodError && 'errors' in zodError && Array.isArray(zodError.errors)) {
                zodError.errors.forEach((err: any) => {
                    const path = err.path?.join('.') || 'unknown';
                    this.logger.warn(`  - ${path}: ${err.message}`);
                });
            }
            this.logger.warn('Continuing with potentially invalid custom properties...');
        }
        
        this.hasValidated = true;
    }

    /**
     * Returns the project definition with custom SFPM properties.
     * Always gets fresh data from SfProject and validates on first access.
     */
    public getProjectDefinition(): ProjectDefinition {
        this.validateCustomProperties();
        return this.project.getSfProjectJson().getContents() as ProjectDefinition;
    }

    /**
     * Finds a package definition by name.
     * Searches through packageDirectories for a matching 'package' field.
     */
    public getPackageDefinition(packageName: string): PackageDefinition {
        // Get all package directories and search for matching package name
        const allPackages = this.getAllPackageDirectories();
        const pkg = allPackages.find(p => p.package === packageName);
        
        if (!pkg) {
            throw new Error(`Package ${packageName} not found in project definition`);
        }
        
        return pkg;
    }

    /**
     * Finds a package definition by its path.
     * Uses SfProject's native getPackage() method for efficient lookup.
     */
    public getPackageDefinitionByPath(packagePath: string): PackageDefinition {
        const pkg = this.project.getPackage(packagePath) as PackageDefinition;
        
        if (!pkg || !pkg.package) {
            throw new Error(`No package found with path: ${packagePath}`);
        }
        
        return pkg;
    }

    /**
     * Returns the source API version of the project
     */
    public get sourceApiVersion(): string | undefined {
        return this.getProjectDefinition().sourceApiVersion;
    }

    /**
     * Returns the project directory (root path)
     */
    public get projectDirectory(): string {
        return this.project.getPath();
    }

    /**
     * Helper to get package type
     */
    public getPackageType(packageName: string): PackageType {
        const pkg = this.getPackageDefinition(packageName);
        if (pkg.type) {
            return pkg.type as PackageType;
        }
        return PackageType.Unlocked;
    }

    public getPackageId(packageAlias: string): string | undefined {
        const aliases = this.project.getSfProjectJson().getContents().packageAliases;
        return aliases?.[packageAlias];
    }

    /**
     * Returns all package directories from the project.
     * Uses raw project JSON to include all fields including 'package'.
     */
    public getAllPackageDirectories(): PackageDefinition[] {
        const projectDef = this.getProjectDefinition();
        return projectDef.packageDirectories as PackageDefinition[];
    }

    /**
     * Returns all unique package names from the 'package' field.
     * Filters out entries without a package name.
     */
    public getAllPackageNames(): string[] {
        const allDirs = this.getAllPackageDirectories();
        return allDirs
            .filter(dir => 'package' in dir && dir.package)
            .map(dir => dir.package as string);
    }

    /**
     * Returns a deep copy of the project definition, pruned to contain only the specified package
     * directory. This is useful for creating artifact-specific manifests (sfdx-project.json)
     * where only the metadata related to one package should be visible.
     * 
     * @param packageName The name of the package to keep in the definition.
     * @returns A new ProjectDefinition containing only the requested package.
     * @throws Error if the package name is not found in the project.
     * 
     * @example
     * ```typescript
     * const pruned = projectConfig.getPrunedDefinition('core-library');
     * console.log(pruned.packageDirectories.length); // 1
     * ```
     */
    public getPrunedDefinition(packageName: string, pruneOptions: { removeCustomProperties: boolean, isOrgDependent: boolean } = { removeCustomProperties: true, isOrgDependent: false }): ProjectDefinition {
        const definition = this.getProjectDefinition();
        let pruned = structuredClone(definition) as ProjectDefinition;

        const filteredPackages = pruned.packageDirectories.filter(
            (pkg): pkg is PackageDefinition => 'package' in pkg && pkg.package === packageName
        );

        if (filteredPackages.length === 0) {
            throw new Error(`Package ${packageName} not found in project definition`);
        }

        if (pruneOptions.removeCustomProperties) {
            pruned.packageDirectories = [this.pruneForSalesforce(filteredPackages[0], pruneOptions.isOrgDependent)];
        } else {
            pruned.packageDirectories = filteredPackages;
        }

        return pruned;
    }

    /**
     * Prunes a package definition for Salesforce CLI compatibility
     */
    private pruneForSalesforce(pkg: PackageDefinition, isOrgDependent: boolean = false): PackageDefinition {

        const standardPkgSchema = ProjectJsonSchema.shape.packageDirectories.element;
        const cleanPkg = standardPkgSchema.parse(pkg) as any;

        if (isOrgDependent && cleanPkg.dependencies) {
            delete cleanPkg.dependencies;
        }

        return cleanPkg;
    }

    /**
     * Saves the project definition back to the file
     */
    /**
     * Saves the project definition back to the file.
     * Note: After saving, validation state is reset since the file has changed.
     */
    public async save(updatedDefinition?: ProjectDefinition): Promise<void> {
        const projectJson = this.project.getSfProjectJson();
        const dataToSave = updatedDefinition || projectJson.getContents();

        // Use individual set calls to avoid protected setContents
        projectJson.set('packageDirectories', dataToSave.packageDirectories);
        if (dataToSave.packageAliases) {
            projectJson.set('packageAliases', dataToSave.packageAliases);
        }
        if (dataToSave.sourceApiVersion) {
            projectJson.set('sourceApiVersion', dataToSave.sourceApiVersion);
        }

        await projectJson.write();
        
        // Reset validation flag since file has changed
        this.hasValidated = false;
    }
}
