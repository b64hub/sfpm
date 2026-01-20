import { ConvertResult } from '@salesforce/source-deploy-retrieve';

export interface AssemblyOptions {
    versionNumber?: string;
    orgDefinitionPath?: string;
    destructiveManifestPath?: string;
    replacementForceignorePath?: string;
}

import { SfpmPackageManifest } from "../../types/package.js";

export interface ManifestAnalysis {
    payload: SfpmPackageManifest;
}

export interface AssemblyOutput {
    stagingDirectory: string;
    manifestPath: string; // Path to the final sfdx-project.json
    metadataApiResult?: ConvertResult; // Populated by the MDAPI Conversion Step
    manifestAnalysis?: ManifestAnalysis; // Populated by the MDAPI Conversion Step
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
