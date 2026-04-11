/**
 * Strategy interface for resolving a ProjectDefinition from different sources.
 *
 * Implementations:
 * - `WorkspaceDefinitionProvider`: reads workspace package.json files (package.json-first)
 * - `SfdxProjectDefinitionProvider`: reads sfdx-project.json (legacy)
 *
 * Used by ProjectService to build the ProjectGraph without coupling to a
 * specific project structure.
 */

import type {ProjectDefinition} from '../types/project.js';
import type {WorkspacePackageJson} from '../types/workspace.js';

/**
 * Provides a ProjectDefinition from some backing source.
 * ProjectService uses this to construct the ProjectGraph.
 */
export interface ProjectDefinitionProvider {
  /** Absolute path to the project root */
  readonly projectDir: string;

  /**
   * Resolve the project definition from the backing source.
   * Returns a standard ProjectDefinition that ProjectGraph can consume.
   */
  resolve(): ProjectDefinitionResult;
}

export interface ProjectDefinitionResult {
  /** The assembled project definition */
  definition: ProjectDefinition;
  /** Workspace package.json data, if resolved from a workspace */
  packages?: Array<{packageDir: string; pkgJson: WorkspacePackageJson}>;
  /** Warnings encountered during resolution */
  warnings?: string[];
}
