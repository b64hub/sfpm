import { SfProject, SfProjectJson, ProjectJsonSchema, ProjectJson } from '@salesforce/core';
import { ProjectDefinition, PackageDefinition, ProjectDefinitionSchema } from '../types/project.js';
import { PackageType } from '../types/package.js';



/**
 * Configuration manager for sfdx-project.json
 */
export default class ProjectConfig {
    private project: SfProject;
    private projectJson: SfProjectJson;
    private definition?: ProjectDefinition;

    constructor(project: SfProject) {
        this.project = project;
        this.projectJson = this.project.getSfProjectJson();
    }

    /**
     * Loads the project definition from the filesystem
     */
    public async load(): Promise<ProjectDefinition> {

        const rawContents = this.projectJson!.getContents();

        // Validate with Zod
        const result = ProjectDefinitionSchema.safeParse(rawContents);
        if (!result.success) {
            throw new Error(`Invalid sfdx-project.json: ${result.error.message}`);
        }

        this.definition = result.data as ProjectDefinition;
        return this.definition;
    }

    /**
     * Returns the validated project definition
     */
    public getProjectDefinition(): ProjectDefinition {
        if (!this.definition) {
            throw new Error('ProjectConfig not loaded. Call load() first.');
        }
        return this.definition;
    }

    /**
     * Finds a package definition by name
     */
    public getPackageDefinition(packageName: string): PackageDefinition {
        const def = this.getProjectDefinition();
        const pkg = def.packageDirectories.find(
            (p): p is PackageDefinition => 'package' in p && p.package === packageName
        );
        if (!pkg) {
            throw new Error(`Package ${packageName} not found in project definition`);
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
        if (!this.project) {
            throw new Error('ProjectConfig not loaded. Call load() first.');
        }
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
        return PackageType.Source;
    }

    public getPackageId(packageAlias: string): string | undefined {
        return this.definition?.packageAliases?.[packageAlias];
    }

    /**
     * Returns all package names
     */
    public getAllPackageNames(): string[] {
        return this.getProjectDefinition().packageDirectories
            .filter((p): p is PackageDefinition => 'package' in p)
            .map(p => p.package);
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
    public async save(updatedDefinition?: ProjectDefinition): Promise<void> {
        if (!this.projectJson) {
            throw new Error('ProjectConfig not loaded. Call load() first.');
        }

        const dataToSave = updatedDefinition || this.definition;
        if (!dataToSave) return;

        // Use individual set calls to avoid protected setContents
        this.projectJson.set('packageDirectories', dataToSave.packageDirectories);
        if (dataToSave.packageAliases) {
            this.projectJson.set('packageAliases', dataToSave.packageAliases);
        }
        if (dataToSave.sourceApiVersion) {
            this.projectJson.set('sourceApiVersion', dataToSave.sourceApiVersion);
        }

        await this.projectJson.write();
        this.definition = dataToSave;
    }
}
