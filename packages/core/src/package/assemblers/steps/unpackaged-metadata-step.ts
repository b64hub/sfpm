import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Copies supplemental metadata defined in `unpackagedMetadata` to staging.
 */
export class UnpackagedMetadataStep implements AssemblyStep {
    /**
     * @description Executes the unpackaged metadata copy operation if a path is defined in the package definition.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output.
     * @throws {Error} If the specified path does not exist or the copy operation fails.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const packageDefinition = options.projectConfig.getPackageDefinition(options.packageName);

        if (!packageDefinition.unpackagedMetadata?.path) {
            return;
        }

        const sourcePath = path.join(options.projectConfig.projectDirectory, packageDefinition.unpackagedMetadata.path);

        try {
            if (await fs.pathExists(sourcePath)) {
                const destPath = path.join(output.stagingDirectory, 'unpackagedMetadata');
                await fs.ensureDir(destPath);
                await fs.copy(sourcePath, destPath);
            } else {
                throw new Error(`unpackagedMetadata ${packageDefinition.unpackagedMetadata.path} does not exist`);
            }
        } catch (error: any) {
            throw new Error(`[UnpackagedMetadataStep] ${error.message}`);
        }
    }
}
