import ArtifactAssembler, { ArtifactAssemblerOptions } from "../../../artifacts/artifact-assembler.js";
import { BuildTask } from "../../package-builder.js";
import SfpmPackage from "../../sfpm-package.js";
import ProjectService from "../../../project/project-service.js";

export interface AssembleArtifactTaskOptions {
    /** npm scope for the package (e.g., "@myorg") - required */
    npmScope: string;
    /** Additional keywords for package.json */
    additionalKeywords?: string[];
    /** Author string for package.json */
    author?: string;
    /** License identifier for package.json */
    license?: string;
    /** Homepage URL */
    homepage?: string;
}

export default class AssembleArtifactTask implements BuildTask {
    private sfpmPackage: SfpmPackage;
    private projectDirectory: string;
    private options: AssembleArtifactTaskOptions;

    public constructor(
        sfpmPackage: SfpmPackage, 
        projectDirectory: string,
        options: AssembleArtifactTaskOptions,
    ) {
        this.sfpmPackage = sfpmPackage;
        this.projectDirectory = projectDirectory;
        this.options = options;
    }

    public async exec(): Promise<void> {
        // Classify dependencies using ProjectService (raw sfdx-project.json names)
        const { versioned, managed } = await ProjectService.classifyDependencies(
            this.sfpmPackage.packageName,
        );

        // Apply npm scope to versioned dependency names for package.json
        const npmScope = this.options.npmScope;
        const scopedDependencies: Record<string, string> = {};
        for (const [name, range] of Object.entries(versioned)) {
            scopedDependencies[`${npmScope}/${name}`] = range;
        }

        const assemblerOptions: ArtifactAssemblerOptions = {
            npmScope: this.options.npmScope,
            additionalKeywords: this.options.additionalKeywords,
            author: this.options.author,
            license: this.options.license,
            homepage: this.options.homepage,
            versionedDependencies: Object.keys(scopedDependencies).length > 0 ? scopedDependencies : undefined,
            managedDependencies: Object.keys(managed).length > 0 ? managed : undefined,
        };

        await new ArtifactAssembler(
            this.sfpmPackage,
            this.projectDirectory,
            assemblerOptions
        ).assemble();
    }
}