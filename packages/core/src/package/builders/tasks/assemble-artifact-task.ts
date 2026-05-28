import ArtifactAssembler, {ArtifactAssemblerOptions} from '../../../artifacts/artifact-assembler.js';
import ProjectService from '../../../project/project-service.js';
import {BuildTask, BuildTaskContext} from '../builder-registry.js';

export interface AssembleArtifactTaskOptions {
  /** Additional keywords to append at build time */
  additionalKeywords?: string[];
}

class AssembleArtifactTask implements BuildTask {
  public readonly name = 'assemble-artifact';
  private readonly ctx: BuildTaskContext;
  private readonly options: AssembleArtifactTaskOptions;

  public constructor(ctx: BuildTaskContext, options: AssembleArtifactTaskOptions) {
    this.ctx = ctx;
    this.options = options;
  }

  public async exec(): Promise<void> {
    const {projectDirectory, sfpmPackage} = this.ctx;

    // Get managed dependencies from the package's project definition
    const projectService = await ProjectService.getInstance(projectDirectory);
    const packageDef = projectService.getPackageDefinition(sfpmPackage.packageName);
    const managed = packageDef.managedDependencies ?? {};

    const assemblerOptions: ArtifactAssemblerOptions = {
      additionalKeywords: this.options.additionalKeywords,
      managedDependencies: Object.keys(managed).length > 0 ? managed : undefined,
    };

    await new ArtifactAssembler(
      sfpmPackage,
      projectDirectory,
      assemblerOptions,
    ).assemble();
  }
}

/** Curried factory for AssembleArtifactTask. */
export function assembleArtifactTask(options: AssembleArtifactTaskOptions = {}): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new AssembleArtifactTask(ctx, options);
}

export default AssembleArtifactTask;
