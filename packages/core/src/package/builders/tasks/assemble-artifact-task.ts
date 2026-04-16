import ArtifactAssembler, {ArtifactAssemblerOptions} from '../../../artifacts/artifact-assembler.js';
import ProjectService from '../../../project/project-service.js';
import SfpmPackage from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';

export interface AssembleArtifactTaskOptions {
  /** Additional keywords to append at build time */
  additionalKeywords?: string[];
}

export default class AssembleArtifactTask implements BuildTask {
  private options: AssembleArtifactTaskOptions;
  private projectDirectory: string;
  private sfpmPackage: SfpmPackage;

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
    const {managed} = await ProjectService.classifyDependencies(this.sfpmPackage.packageName, this.projectDirectory);

    const assemblerOptions: ArtifactAssemblerOptions = {
      additionalKeywords: this.options.additionalKeywords,
      managedDependencies: Object.keys(managed).length > 0 ? managed : undefined,
    };

    await new ArtifactAssembler(
      this.sfpmPackage,
      this.projectDirectory,
      assemblerOptions,
    ).assemble();
  }
}
