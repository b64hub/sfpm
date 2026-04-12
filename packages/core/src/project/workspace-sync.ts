/**
 * Workspace sync service: generates sfdx-project.json from workspace package.json files.
 *
 * This is the core engine behind `sfpm sync`. It delegates workspace discovery
 * and ProjectDefinition assembly to WorkspaceResolver, then writes the result
 * to sfdx-project.json.
 *
 * @example
 * ```typescript
 * const sync = new WorkspaceSync({ projectDir: '/path/to/project', logger });
 * const result = await sync.run();
 * // → sfdx-project.json written
 * ```
 */

import path from 'node:path';

import type {Logger} from '../types/logger.js';
import type {
  WorkspaceSyncPackage,
  WorkspaceSyncResult,
} from '../types/workspace.js';

import {stripScope} from './package-json-adapter.js';
import {WorkspaceProvider} from './providers/workspace-provider.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WorkspaceSyncOptions {
  /** Logger for diagnostic output */
  logger?: Logger;
  /** Salesforce namespace (empty string for no namespace) */
  namespace?: string;
  /** Absolute path to the project root directory */
  projectDir: string;
  /** Salesforce login URL. Default: 'https://login.salesforce.com' */
  sfdcLoginUrl?: string;
  /** Source API version for sfdx-project.json (e.g., "63.0") */
  sourceApiVersion?: string;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class WorkspaceSync {
  private readonly logger: Logger | undefined;
  private readonly options: WorkspaceSyncOptions;

  constructor(options: WorkspaceSyncOptions) {
    this.options = options;
    this.logger = options.logger;
  }

  /**
   * Run the sync: discover workspace packages, generate sfdx-project.json.
   */
  async run(): Promise<WorkspaceSyncResult> {
    // Delegate discovery and definition building to WorkspaceProvider
    const provider = new WorkspaceProvider({
      logger: this.logger,
      namespace: this.options.namespace,
      projectDir: this.options.projectDir,
      sfdcLoginUrl: this.options.sfdcLoginUrl,
      sourceApiVersion: this.options.sourceApiVersion,
    });

    const {definition: projectDefinition, packages: sfpmPackages, warnings} = provider.resolve();

    this.logger?.info(`Found ${sfpmPackages?.length ?? 0} SFPM package(s): ${sfpmPackages?.map(p => p.pkgJson.name).join(', ') ?? ''}`);

    // Write sfdx-project.json
    const sfdxProjectPath = path.join(this.options.projectDir, 'sfdx-project.json');
    WorkspaceProvider.ensureSfdxProject(this.options.projectDir, projectDefinition);
    this.logger?.info(`Generated ${sfdxProjectPath}`);

    // Build result
    const packages: WorkspaceSyncPackage[] = (sfpmPackages ?? []).map(({packageDir, pkgJson}) => ({
      name: stripScope(pkgJson.name),
      packageDir,
      type: pkgJson.sfpm.packageType,
    }));

    return {
      packages,
      sfdxProjectPath,
      warnings: warnings ?? [],
    };
  }
}
