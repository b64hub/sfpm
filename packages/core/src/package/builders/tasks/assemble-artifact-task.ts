import ArtifactAssembler, {ArtifactAssemblerOptions} from '../../../artifacts/artifact-assembler.js';
import ProjectService from '../../../project/project-service.js';
import SfpmPackage from '../../sfpm-package.js';
import {BuildTask} from '../builder-registry.js';

export interface AssembleArtifactTaskOptions {
  /** Additional keywords for package.json */
  additionalKeywords?: string[];
  /** Author string for package.json */
  author?: string;
  /** Homepage URL */
  homepage?: string;
  /** License identifier for package.json */
  license?: string;
  /** Suppress npm pack notice output (default: true) */
  quietPack?: boolean;
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
    const {managed, versioned} = await ProjectService.classifyDependencies(this.sfpmPackage.packageName, this.projectDirectory);

    // Resolve scoped npm names for versioned dependencies by looking up each dep's PackageDefinition
    const projectService = await ProjectService.getInstance(this.projectDirectory);
    const scopedDependencies: Record<string, string> = {};
    for (const [name, range] of Object.entries(versioned)) {
      const depDefinition = projectService.getPackageDefinition(name);
      const npmName = depDefinition.npmName ?? name;
      scopedDependencies[npmName] = range;
    }

    const assemblerOptions: ArtifactAssemblerOptions = {
      additionalKeywords: this.options.additionalKeywords,
      author: this.options.author,
      homepage: this.options.homepage,
      license: this.options.license,
      managedDependencies: Object.keys(managed).length > 0 ? managed : undefined,
      quietPack: this.options.quietPack,
      versionedDependencies: Object.keys(scopedDependencies).length > 0 ? scopedDependencies : undefined,
    };

    await new ArtifactAssembler(
      this.sfpmPackage,
      this.projectDirectory,
      assemblerOptions,
    ).assemble();
  }
}
