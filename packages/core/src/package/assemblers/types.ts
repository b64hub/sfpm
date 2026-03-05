import { ConvertResult } from '@salesforce/source-deploy-retrieve';
import { IgnoreFilesConfig } from '../../types/config.js';


export interface AssemblyOptions {
    versionNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    replacementForceignorePath?: string;
    /** Stage-specific ignore files from sfpm.config.ts */
    ignoreFilesConfig?: IgnoreFilesConfig;
}

export interface AssemblyOutput {
    stagingDirectory: string;
    projectDefinitionPath?: string;
    componentCount?: number;
    // mdapiConversion?: {
    //     payload: SfpmPackageManifest;
    //     result: ConvertResult;
    // }; // Populated by the MDAPI Conversion Step
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
