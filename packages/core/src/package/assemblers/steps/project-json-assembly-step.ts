import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import * as fs from 'fs-extra';
import path from 'path';
import { PackageDefinition } from "../../../types/project.js";


/**
 * @description Finalizes the assembly process by generating a pruned `sfdx-project.json`
 * specifically tailored for the Current Package.
 * 
 * It also:
 * 1. Injects the provided version number.
 * 2. Updates paths to reference the staging area structure.
 * 3. Archives the original project manifest for reference.
 */
export class ProjectJsonAssemblyStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        try {
            const prunedManifest = this.projectConfig.getPrunedDefinition(this.packageName);

            if (options.versionNumber) {
                (prunedManifest.packageDirectories[0] as PackageDefinition).versionNumber = options.versionNumber;
            }

            const pkg = prunedManifest.packageDirectories[0] as PackageDefinition;
            if (!pkg.packageOptions) {
                pkg.packageOptions = {};
            }

            // use absolute path for unpackaged metadata
            const unpackagedMetadataDir = path.join(output.stagingDirectory, 'unpackagedMetadata');
            if (await fs.pathExists(unpackagedMetadataDir)) {
                pkg.unpackagedMetadata = { path: unpackagedMetadataDir };
            }

            if (await fs.pathExists(path.join(output.stagingDirectory, 'scripts', 'preDeployment'))) {
                this.initializeDeploymentOptions(pkg, 'pre');
                pkg.packageOptions!.deploy!.pre!.script = path.join('scripts', 'preDeployment');
            }

            if (await fs.pathExists(path.join(output.stagingDirectory, 'scripts', 'postDeployment'))) {
                this.initializeDeploymentOptions(pkg, 'post');
                pkg.packageOptions!.deploy!.post!.script = path.join('scripts', 'postDeployment');
            }

            const projectJsonPath = path.join(output.stagingDirectory, 'sfdx-project.json');
            await fs.writeJSON(projectJsonPath, prunedManifest, { spaces: 4 });
            output.projectDefinitionPath = projectJsonPath;

            const manifestsDir = path.join(output.stagingDirectory, 'manifests');
            await fs.ensureDir(manifestsDir);
            await fs.copy(
                path.join(this.projectConfig.projectDirectory, 'sfdx-project.json'),
                path.join(manifestsDir, 'sfdx-project.json.original')
            );

        } catch (error) {
            throw new Error(`[ManifestAssemblyStep] ${(error as Error).message}`);
        }
    }

    private initializeDeploymentOptions(pkg: PackageDefinition, stage: 'pre' | 'post'): void {
        if (!pkg.packageOptions!.deploy) {
            pkg.packageOptions!.deploy = {};
        }
        if (!pkg.packageOptions!.deploy[stage]) {
            pkg.packageOptions!.deploy[stage] = {};
        }
    }
}
