import {ConvertResult} from '@salesforce/source-deploy-retrieve';

import type {WorkspacePackageJson} from '../../types/workspace.js';

import {IgnoreFilesConfig} from '../../types/config.js';

export interface AssemblyOptions {
  destructiveManifestPath?: string;
  /** Stage-specific ignore files from sfpm.config.ts */
  ignoreFilesConfig?: IgnoreFilesConfig;
  orgDefinitionPath?: string;
  replacementForceignorePath?: string;
  versionNumber?: string;
  /** Workspace package.json for package.json-first assembly (turbo mode) */
  workspacePackageJson?: WorkspacePackageJson;
}

export interface AssemblyOutput {
  componentCount?: number;
  projectDefinitionPath?: string;
  // mdapiConversion?: {
  //     payload: SfpmPackageManifest;
  //     result: ConvertResult;
  // }; // Populated by the MDAPI Conversion Step
  scripts?: {
    post?: string[];
    pre?: string[];
  };
  stagingDirectory: string;
}

export interface AssemblyStep {
  /**
   * @param options Shared state and configuration for the build
   * @param output The output object to be populated
   */
  execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void>;
}
