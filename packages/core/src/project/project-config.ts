import { SfProject, SfProjectJson } from '@salesforce/core';
import { ProjectDefinition, PackageDefinition, ProjectDefinitionSchema } from './types.js';
import { PackageType } from '../types/package.js';

/**
 * Configuration manager for sfdx-project.json
 */
export default class ProjectConfig {
    private project: SfProject | undefined;
    private projectJson: SfProjectJson | undefined;
    private definition: ProjectDefinition | undefined;

    constructor(private projectOrDirectory?: SfProject | string) {
        if (projectOrDirectory instanceof SfProject) {
            this.project = projectOrDirectory;
            this.projectJson = this.project.getSfProjectJson();
        }
    }

    /**
     * Loads the project definition from the filesystem
     */
    public async load(): Promise<ProjectDefinition> {
        if (!this.project) {
            const workingDirectory = typeof this.projectOrDirectory === 'string' ? this.projectOrDirectory : undefined;
            this.project = await SfProject.resolve(workingDirectory);
            this.projectJson = this.project.getSfProjectJson();
        }

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
        const pkg = def.packageDirectories.find(p => p.package === packageName);
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

    /**
     * Returns all package names
     */
    public getAllPackageNames(): string[] {
        return this.getProjectDefinition().packageDirectories.map(p => p.package);
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
