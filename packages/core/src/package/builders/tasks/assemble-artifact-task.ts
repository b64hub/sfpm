import path from 'path';
import ArtifactAssembler from "../../../artifacts/artifact-assembler.js";
import { BuildTask } from "../../package-builder.js";
import SfpmPackage from "../../sfpm-package.js";

export default class AssembleArtifactTask implements BuildTask {
    private sfpmPackage: SfpmPackage;
    private projectDirectory: string;

    public constructor(sfpmPackage: SfpmPackage, projectDirectory: string) {
        this.sfpmPackage = sfpmPackage;
        this.projectDirectory = projectDirectory;
    }

    public async exec(): Promise<void> {
        // Generate Artifact in artifacts directory at project root
        const artifactsRootDir = path.join(this.projectDirectory, 'artifacts');
        
        await new ArtifactAssembler(
            this.sfpmPackage,
            this.projectDirectory,
            artifactsRootDir
        ).assemble();

        return;
    }
    
}