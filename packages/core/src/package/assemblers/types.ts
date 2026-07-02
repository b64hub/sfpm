export interface AssemblyOptions {
  destructiveManifestPath?: string;
  orgDefinitionPath?: string;
  replacementForceignorePath?: string;
  versionNumber?: string;
}

export interface AssemblyOutput {
  componentCount?: number;
  /** Staged metadata dependency paths (set by MetadataDependenciesStep) */
  metadataPaths?: {
    seed?: string;
    unpackaged?: string;
  };
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
