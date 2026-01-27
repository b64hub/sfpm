import ArtifactAssembler from "../../../artifacts/artifact-assembler.js";
import { BuildTask } from "../../package-builder.js";
import SfpmPackage from "../../sfpm-package.js";

export default class AssembleArtifactTask implements BuildTask {
    private sfpmPackage: SfpmPackage;
    private artifactDirectory: string;

    public constructor(sfpmPackage: SfpmPackage, artifactDirectory: string) {
        this.sfpmPackage = sfpmPackage;
        this.artifactDirectory = artifactDirectory;
    }

    public async exec(): Promise<void> {
        //Generate Artifact
        await new ArtifactAssembler(
            this.sfpmPackage,
            process.cwd(),
            this.artifactDirectory
        ).assemble();

        return;
    }
    
}