import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import { ComponentSet } from "@salesforce/source-deploy-retrieve";
import fs from 'fs-extra';
import path from 'path';

/**
 * @description Copies the primary package directory to the staging area.
 * This step ensures that the core source code of the package is present in the artifact.
 */
export class SourceCopyStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    /**
     * @description Executes the source copy operation.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output.
     * @throws {Error} If the copy operation fails.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const packageDefinition = this.projectConfig.getPackageDefinition(this.packageName);
        const sourceDir = path.join(this.projectConfig.projectDirectory, packageDefinition.path);
        const destinationDir = path.join(output.stagingDirectory, packageDefinition.path);

        this.logger?.debug(`[SourceCopyStep] Copying main context from ${sourceDir} to ${destinationDir}`);

        try {
            await fs.copy(sourceDir, destinationDir);
            
            // Count components in the copied source
            const componentSet = ComponentSet.fromSource(destinationDir);
            output.componentCount = componentSet.size;
        } catch (error: any) {
            throw new Error(`[SourceCopyStep] Failed to copy source: ${error.message}`);
        }
    }
}
