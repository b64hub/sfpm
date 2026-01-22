import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import * as fs from 'fs-extra';
import path from 'path';
import { PackageDefinition } from "../../../project/types.js";
import { PackageType } from "../../../types/package.js";

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

            // Inject the versionNumber if provided
            if (options.versionNumber) {
                prunedManifest.packageDirectories[0].versionNumber = options.versionNumber;
            }

            // Update paths to be relative to the artifact root
            if (await fs.pathExists(path.join(output.stagingDirectory, 'unpackagedMetadata'))) {
                (prunedManifest.packageDirectories[0] as PackageDefinition).unpackagedMetadata = { path: 'unpackagedMetadata' };
                prunedManifest.packageDirectories.push({
                    path: 'unpackagedMetadata',
                    package: 'unpackagedMetadata',
                    versionNumber: '0.0.0.0',
                    type: PackageType.Source,
                    default: false
                });
            }

            if (await fs.pathExists(path.join(output.stagingDirectory, 'scripts', 'preDeployment'))) {
                (prunedManifest.packageDirectories[0] as PackageDefinition).preDeploymentScript = path.join('scripts', 'preDeployment');
            }

            if (await fs.pathExists(path.join(output.stagingDirectory, 'scripts', 'postDeployment'))) {
                (prunedManifest.packageDirectories[0] as PackageDefinition).postDeploymentScript = path.join('scripts', 'postDeployment');
            }

            const manifestPath = path.join(output.stagingDirectory, 'sfdx-project.json');
            await fs.writeJSON(manifestPath, prunedManifest, { spaces: 4 });
            output.manifestPath = manifestPath;

            const manifestsDir = path.join(output.stagingDirectory, 'manifests');
            await fs.ensureDir(manifestsDir);
            await fs.copy(
                path.join(this.projectConfig.projectDirectory, 'sfdx-project.json'),
                path.join(manifestsDir, 'sfdx-project.json.original')
            );
        } catch (error: any) {
            throw new Error(`[ManifestAssemblyStep] ${error.message}`);
        }
    }
}
