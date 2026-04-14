import {IgnoreFilesConfig} from '../../types/config.js';

export interface AssemblyOptions {
  destructiveManifestPath?: string;
  ignoreFilesConfig?: IgnoreFilesConfig;
  orgDefinitionPath?: string;
  replacementForceignorePath?: string;
  versionNumber?: string;
}

export interface AssemblyOutput {
  componentCount?: number;
  projectDefinitionPath?: string;
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
