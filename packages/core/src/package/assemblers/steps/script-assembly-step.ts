import { AssemblyStep, AssemblyOptions } from "../types.js";
import * as fs from 'fs-extra';
import path from 'path';

/**
 * @description Copies pre and post-deployment scripts to the `/scripts` subdirectory in the staging area.
 * It renames the scripts to 'preDeployment' and 'postDeployment' for standardized discovery by installers.
 */
export class ScriptAssemblyStep implements AssemblyStep {
    /**
     * @description Executes the script assembly operation.
     * @param options Shared assembly configuration.
     * @param stagingDirectory The target directory for assembly.
     */
    public async execute(options: AssemblyOptions, stagingDirectory: string): Promise<void> {
        const packageDefinition = options.projectConfig.getPackageDefinition(options.packageName);
        const preDeploymentScript = packageDefinition.preDeploymentScript;
        const postDeploymentScript = packageDefinition.postDeploymentScript;

        if (!preDeploymentScript && !postDeploymentScript) {
            return;
        }

        const scriptsDir = path.join(stagingDirectory, 'scripts');
        await fs.ensureDir(scriptsDir);

        if (preDeploymentScript) {
            await this.copyScript(options, scriptsDir, preDeploymentScript, 'preDeployment');
        }

        if (postDeploymentScript) {
            await this.copyScript(options, scriptsDir, postDeploymentScript, 'postDeployment');
        }
    }

    private async copyScript(options: AssemblyOptions, scriptsDir: string, scriptPath: string, scriptLabel: string): Promise<void> {
        const resolvedPath = path.isAbsolute(scriptPath)
            ? scriptPath
            : path.join(options.projectConfig.projectDirectory, scriptPath);

        try {
            if (!(await fs.pathExists(resolvedPath))) {
                throw new Error(`${scriptLabel}Script ${resolvedPath} does not exist`);
            }
            await fs.copy(resolvedPath, path.join(scriptsDir, scriptLabel));
        } catch (error: any) {
            throw new Error(`[ScriptAssemblyStep] ${error.message}`);
        }
    }
}
