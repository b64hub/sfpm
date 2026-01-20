import ProjectConfig from "../../project/project-config.js";
import { Logger } from "../../types/logger.js";

export interface AssemblyOptions {
    packageName: string;
    projectConfig: ProjectConfig;
    versionNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    replacementForceignorePath?: string;
    logger?: Logger;
}

export interface AssemblyStep {
    /**
     * @param options Shared state and configuration for the build
     * @param stagingDirectory The path where files are being assembled
     */
    execute(options: AssemblyOptions, stagingDirectory: string): Promise<void>;
}
