import path from 'path';
import ArtifactAssembler, { ArtifactAssemblerOptions } from "../../../artifacts/artifact-assembler.js";
import { BuildTask } from "../../package-builder.js";
import SfpmPackage from "../../sfpm-package.js";

export interface AssembleArtifactTaskOptions {
    /** npm scope for the package (e.g., "@myorg") - required */
    npmScope: string;
    /** Additional keywords for package.json */
    additionalKeywords?: string[];
    /** Author string for package.json */
    author?: string;
    /** License identifier for package.json */
    license?: string;
}

export default class AssembleArtifactTask implements BuildTask {
    private sfpmPackage: SfpmPackage;
    private projectDirectory: string;
    private options: AssembleArtifactTaskOptions;

    public constructor(
        sfpmPackage: SfpmPackage, 
        projectDirectory: string,
        options: AssembleArtifactTaskOptions
    ) {
        this.sfpmPackage = sfpmPackage;
        this.projectDirectory = projectDirectory;
        this.options = options;
    }

    public async exec(): Promise<void> {
        const assemblerOptions: ArtifactAssemblerOptions = {
            npmScope: this.options.npmScope,
            additionalKeywords: this.options.additionalKeywords,
            author: this.options.author,
            license: this.options.license,
        };

        await new ArtifactAssembler(
            this.sfpmPackage,
            this.projectDirectory,
            assemblerOptions
        ).assemble();
    }
}