import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
import { Logger } from "../../../types/logger.js";
import ProjectConfig from "../../../project/project-config.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Handles organization definition files, typically `project-scratch-def.json`.
 * If a path is provided, it's copied to the `/config` folder in the staging area.
 */
export class OrgDefinitionStep implements AssemblyStep {
    constructor(
        private packageName: string,
        private projectConfig: ProjectConfig,
        private logger?: Logger
    ) { }

    /**
     * @description Executes the organization definition assembly.
     * @param options Shared assembly configuration.
     * @param output Shared assembly output.
     * @throws {Error} If the copy operation fails.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        if (!options.orgDefinitionPath) {
            return;
        }

        const sourcePath = path.isAbsolute(options.orgDefinitionPath)
            ? options.orgDefinitionPath
            : path.join(this.projectConfig.projectDirectory, options.orgDefinitionPath);

        try {
            if (!(await fs.pathExists(sourcePath))) {
                this.logger?.warn(`Config file ${sourcePath} not found.`);
                return;
            }

            const destDir = path.join(output.stagingDirectory, 'config');
            await fs.ensureDir(destDir);
            await fs.copy(sourcePath, path.join(destDir, 'project-scratch-def.json'));
        } catch (error: any) {
            throw new Error(`[OrgDefinitionStep] ${error.message}`);
        }
    }
}
