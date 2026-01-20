import { AssemblyStep, AssemblyOptions, AssemblyOutput } from "../types.js";
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
     * @param output Shared assembly output.
     */
    public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
        const packageDefinition = options.projectConfig.getPackageDefinition(options.packageName);
        const preDeploymentScript = packageDefinition.preDeploymentScript;
        const postDeploymentScript = packageDefinition.postDeploymentScript;

        if (!preDeploymentScript && !postDeploymentScript) {
            return;
        }

        const scriptsDir = path.join(output.stagingDirectory, 'scripts');
        await fs.ensureDir(scriptsDir);

        if (preDeploymentScript) {
            await this.copyScript(options, scriptsDir, preDeploymentScript, 'preDeployment');
            output.scripts = { ...output.scripts, preDeployment: path.join(scriptsDir, 'preDeployment') };
        }

        if (postDeploymentScript) {
            await this.copyScript(options, scriptsDir, postDeploymentScript, 'postDeployment');
            output.scripts = { ...output.scripts, postDeployment: path.join(scriptsDir, 'postDeployment') };
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
