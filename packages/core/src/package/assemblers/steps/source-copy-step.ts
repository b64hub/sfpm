import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Copies the primary package directory to the staging area.
 * This step ensures that the core source code of the package is present in the artifact.
 */
export class SourceCopyStep implements AssemblyStep {
    /**
     * @description Executes the source copy operation.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output.
     * @throws {Error} If the copy operation fails.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const projectDirectory = options.projectConfig.projectDirectory;
        const packageDefinition = options.projectConfig.getPackageDefinition(options.packageName);
        const packagePath = packageDefinition.path;

        const sourcePath = path.join(projectDirectory, packagePath);
        const destPath = path.join(output.stagingDirectory, packagePath);

        options.logger?.debug(`[SourceCopyStep] Copying ${sourcePath} to ${destPath}`);

        try {
            await fs.copy(sourcePath, destPath);
        } catch (error: any) {
            throw new Error(`[SourceCopyStep] Failed to copy source: ${error.message}`);
        }
    }
}
