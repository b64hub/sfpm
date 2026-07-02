import fs from 'fs-extra';
import path from 'node:path';

import Logger from '../types/logger.js';
import {OrgAliasConfig, OrgAliasMode} from '../types/project.js';

export const ORG_ALIAS_DEFAULT_DIR = 'default';
const DEFAULT_MODE: OrgAliasMode = 'union';

export interface OrgAliasResolution {
  /** The effective source directory to use for deployment */
  effectivePath: string;
  /** Whether a matching org directory was found (vs falling back to default) */
  matched: boolean;
  /** The org alias that was matched, or 'default' if fallback */
  resolvedAlias: string;
}

/**
 * Resolves which source directory to use for org-aliased packages.
 *
 * An org-aliased package has subdirectories named after target org aliases
 * (e.g., `uat/`, `prod/`) plus a mandatory `default/` directory. At install
 * time, the target org alias is matched against these directory names.
 *
 * Supports two merge modes:
 * - **union**: copies default, then overlays the org directory on top (org wins conflicts)
 * - **disjoint**: uses only the org directory, ignoring default entirely
 */
export class OrgAliasResolver {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * List available org aliases for a package.
   */
  public async getAvailableAliases(packagePath: string): Promise<string[]> {
    if (!await fs.pathExists(packagePath)) {
      return [];
    }

    const entries = await fs.readdir(packagePath, {withFileTypes: true});
    return entries
    .filter(e => e.isDirectory() && e.name !== ORG_ALIAS_DEFAULT_DIR)
    .map(e => e.name);
  }

  /**
   * Resolve the effective source path for an org-aliased package.
   *
   * @param packagePath - Absolute path to the package root (containing org subdirectories)
   * @param targetOrg - The target org alias/username to match against org directories
   * @param config - Org alias configuration (mode, etc.)
   * @returns Resolution result with the effective path and match info
   */
  public async resolve(
    packagePath: string,
    targetOrg: string,
    config?: boolean | OrgAliasConfig,
  ): Promise<OrgAliasResolution> {
    const mode = this.resolveMode(config);
    const defaultDir = path.join(packagePath, ORG_ALIAS_DEFAULT_DIR);

    if (!await fs.pathExists(defaultDir)) {
      throw new Error(`Org-aliased package is missing required '${ORG_ALIAS_DEFAULT_DIR}/' directory: ${packagePath}`);
    }

    // Match target org against org subdirectories
    const orgDir = path.join(packagePath, targetOrg);
    const orgExists = await fs.pathExists(orgDir);

    if (!orgExists) {
      this.logger?.info(`No org directory '${targetOrg}' found, using default`);
      return {
        effectivePath: defaultDir,
        matched: false,
        resolvedAlias: ORG_ALIAS_DEFAULT_DIR,
      };
    }

    this.logger?.info(`Matched org alias '${targetOrg}' with mode '${mode}'`);

    if (mode === 'disjoint') {
      return {
        effectivePath: orgDir,
        matched: true,
        resolvedAlias: targetOrg,
      };
    }

    // Union mode: merge default + org into a temporary directory
    const mergedDir = await this.mergeDirectories(defaultDir, orgDir, packagePath, targetOrg);
    return {
      effectivePath: mergedDir,
      matched: true,
      resolvedAlias: targetOrg,
    };
  }

  /**
   * Merge the default directory with the org directory.
   * Copies default first, then overlays org on top (org wins on conflict).
   */
  private async mergeDirectories(
    defaultDir: string,
    orgDir: string,
    packagePath: string,
    targetOrg: string,
  ): Promise<string> {
    const mergedDir = path.join(packagePath, '.sfpm', `org-merged-${targetOrg}`);

    // Clean any previous merge
    await fs.remove(mergedDir);
    await fs.ensureDir(mergedDir);

    // Copy default as base
    await fs.copy(defaultDir, mergedDir, {overwrite: true});

    // Overlay org on top (org wins conflicts)
    await fs.copy(orgDir, mergedDir, {overwrite: true});

    this.logger?.debug(`Merged org '${targetOrg}' onto default at: ${mergedDir}`);
    return mergedDir;
  }

  private resolveMode(config?: boolean | OrgAliasConfig): OrgAliasMode {
    if (config === undefined || config === true) {
      return DEFAULT_MODE;
    }

    if (typeof config === 'object' && config.mode) {
      return config.mode;
    }

    return DEFAULT_MODE;
  }
}
