import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description If a destructive manifest path is provided, this step copies it to the `/destructive`
 * folder in the staging area and renames it to `destructiveChanges.xml` for standardized deployment.
 */
export class DestructiveManifestStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    /**
     * @description Executes the destructive manifest assembly.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output.
     * @throws {Error} If the copy operation fails.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        if (!options.destructiveManifestPath) {
            return;
        }

        const sourcePath = path.isAbsolute(options.destructiveManifestPath)
            ? options.destructiveManifestPath
            : path.join(this.projectConfig.projectDirectory, options.destructiveManifestPath);

        try {
            if (!(await fs.pathExists(sourcePath))) {
                this.logger?.warn(`Destructive manifest ${sourcePath} not found.`);
                return;
            }

            const destDir = path.join(output.stagingDirectory, 'destructive');
            await fs.ensureDir(destDir);
            await fs.copy(sourcePath, path.join(destDir, 'destructiveChanges.xml'));
        } catch (error: any) {
            throw new Error(`[DestructiveManifestStep] ${error.message}`);
        }
    }
}
