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
  /** npm scope for the package (e.g., "@myorg") - required */
  npmScope: string;
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

    // Apply npm scope to versioned dependency names for package.json
    const {npmScope} = this.options;
    const scopedDependencies: Record<string, string> = {};
    for (const [name, range] of Object.entries(versioned)) {
      scopedDependencies[`${npmScope}/${name}`] = range;
    }

    const assemblerOptions: ArtifactAssemblerOptions = {
      additionalKeywords: this.options.additionalKeywords,
      author: this.options.author,
      homepage: this.options.homepage,
      license: this.options.license,
      managedDependencies: Object.keys(managed).length > 0 ? managed : undefined,
      npmScope: this.options.npmScope,
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
