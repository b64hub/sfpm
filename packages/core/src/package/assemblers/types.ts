import ProjectConfig from "../../project/project-config.js";
import { Logger } from "../../types/logger.js";
import { ConvertResult } from '@salesforce/source-deploy-retrieve';

export interface AssemblyOptions {
    packageName: string;
    projectConfig: ProjectConfig;
    versionNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    replacementForceignorePath?: string;
}

export interface AssemblyOutput {
    stagingDirectory: string;
    manifestPath: string; // Path to the final sfdx-project.json
    metadataApiResult?: ConvertResult; // Populated by the MDAPI Conversion Step
    scripts?: {
        preDeployment?: string;
        postDeployment?: string;
    };
}

export interface AssemblyStep {
    /**
     * @param options Shared state and configuration for the build
     * @param output The output object to be populated
     */
    execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void>;
}
