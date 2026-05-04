import fs from 'fs-extra';
import path from 'node:path';

import {Logger} from '../types/logger.js';
import {EnvAliasConfig, EnvAliasMode} from '../types/project.js';

export const ENV_ALIAS_DEFAULT_DIR = 'default';
const DEFAULT_MODE: EnvAliasMode = 'union';

export interface EnvAliasResolution {
  /** The effective source directory to use for deployment */
  effectivePath: string;
  /** Whether a matching env directory was found (vs falling back to default) */
  matched: boolean;
  /** The env alias that was matched, or 'default' if fallback */
  resolvedAlias: string;
}

/**
 * Resolves which source directory to use for env-aliased packages.
 *
 * An env-aliased package has subdirectories named after target environments
 * (e.g., `uat/`, `prod/`) plus a mandatory `default/` directory. At install
 * time, the target org alias is matched against these directory names.
 *
 * Supports two merge modes:
 * - **union**: copies default, then overlays the env directory on top (env wins conflicts)
 * - **disjoint**: uses only the env directory, ignoring default entirely
 */
export class EnvAliasResolver {
  private logger?: Logger;

  constructor(logger?: Logger) {
    this.logger = logger;
  }

  /**
   * List available env aliases for a package.
   */
  public async getAvailableAliases(packagePath: string): Promise<string[]> {
    if (!await fs.pathExists(packagePath)) {
      return [];
    }

    const entries = await fs.readdir(packagePath, {withFileTypes: true});
    return entries
    .filter(e => e.isDirectory() && e.name !== ENV_ALIAS_DEFAULT_DIR)
    .map(e => e.name);
  }

  /**
   * Resolve the effective source path for an env-aliased package.
   *
   * @param packagePath - Absolute path to the package root (containing env subdirectories)
   * @param targetOrg - The target org alias/username to match against env directories
   * @param config - Env alias configuration (mode, etc.)
   * @returns Resolution result with the effective path and match info
   */
  public async resolve(
    packagePath: string,
    targetOrg: string,
    config?: boolean | EnvAliasConfig,
  ): Promise<EnvAliasResolution> {
    const mode = this.resolveMode(config);
    const defaultDir = path.join(packagePath, ENV_ALIAS_DEFAULT_DIR);

    if (!await fs.pathExists(defaultDir)) {
      throw new Error(`Env-aliased package is missing required '${ENV_ALIAS_DEFAULT_DIR}/' directory: ${packagePath}`);
    }

    // Match target org against env subdirectories
    const envDir = path.join(packagePath, targetOrg);
    const envExists = await fs.pathExists(envDir);

    if (!envExists) {
      this.logger?.info(`No env directory '${targetOrg}' found, using default`);
      return {
        effectivePath: defaultDir,
        matched: false,
        resolvedAlias: ENV_ALIAS_DEFAULT_DIR,
      };
    }

    this.logger?.info(`Matched env alias '${targetOrg}' with mode '${mode}'`);

    if (mode === 'disjoint') {
      return {
        effectivePath: envDir,
        matched: true,
        resolvedAlias: targetOrg,
      };
    }

    // Union mode: merge default + env into a temporary directory
    const mergedDir = await this.mergeDirectories(defaultDir, envDir, packagePath, targetOrg);
    return {
      effectivePath: mergedDir,
      matched: true,
      resolvedAlias: targetOrg,
    };
  }

  /**
   * Merge the default directory with the env directory.
   * Copies default first, then overlays env on top (env wins on conflict).
   */
  private async mergeDirectories(
    defaultDir: string,
    envDir: string,
    packagePath: string,
    targetOrg: string,
  ): Promise<string> {
    const mergedDir = path.join(packagePath, '.sfpm', `env-merged-${targetOrg}`);

    // Clean any previous merge
    await fs.remove(mergedDir);
    await fs.ensureDir(mergedDir);

    // Copy default as base
    await fs.copy(defaultDir, mergedDir, {overwrite: true});

    // Overlay env on top (env wins conflicts)
    await fs.copy(envDir, mergedDir, {overwrite: true});

    this.logger?.debug(`Merged env '${targetOrg}' onto default at: ${mergedDir}`);
    return mergedDir;
  }

  private resolveMode(config?: boolean | EnvAliasConfig): EnvAliasMode {
    if (config === undefined || config === true) {
      return DEFAULT_MODE;
    }

    if (typeof config === 'object' && config.mode) {
      return config.mode;
    }

    return DEFAULT_MODE;
  }
}
