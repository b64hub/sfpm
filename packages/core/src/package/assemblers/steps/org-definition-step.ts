import { AssemblyStep, AssemblyOptions } from "../types.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Handles organization definition files, typically `project-scratch-def.json`.
 * If a path is provided, it's copied to the `/config` folder in the staging area.
 */
export class OrgDefinitionStep implements AssemblyStep {
    /**
     * @description Executes the organization definition assembly.
     * @param options Shared assembly configuration.
     * @param stagingDirectory The target directory for assembly.
     * @throws {Error} If the copy operation fails.
     */
    public async execute(options: AssemblyOptions, stagingDirectory: string): Promise<void> {
        if (!options.orgDefinitionPath) {
            return;
        }

        const sourcePath = path.isAbsolute(options.orgDefinitionPath)
            ? options.orgDefinitionPath
            : path.join(options.projectConfig.projectDirectory, options.orgDefinitionPath);

        try {
            if (!(await fs.pathExists(sourcePath))) {
                options.logger?.warn(`Config file ${sourcePath} not found.`);
                return;
            }

            const destDir = path.join(stagingDirectory, 'config');
            await fs.ensureDir(destDir);
            await fs.copy(sourcePath, path.join(destDir, 'project-scratch-def.json'));
        } catch (error: any) {
            throw new Error(`[OrgDefinitionStep] ${error.message}`);
        }
    }
}
