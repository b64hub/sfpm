import {execSync} from 'node:child_process';
import path from 'node:path';

import fs from 'fs-extra';

import {Logger} from '../../types/logger.js';
import {
  DownloadResult,
  RegistryClient,
  RegistryClientConfig,
  RegistryPackageInfo,
  RegistryVersionInfo,
} from './registry-client.js';

/**
 * Registry client that delegates to the pnpm CLI.
 *
 * Instead of making raw HTTP calls and parsing `.npmrc` ourselves, this
 * implementation shells out to `pnpm view` and `pnpm pack` — letting pnpm
 * handle registry resolution, scoped registries, auth tokens, proxy config,
 * and all other `.npmrc` concerns natively.
 *
 * This keeps SFPM's responsibility focused on the Salesforce packaging layer
 * while the package manager owns the npm registry relationship.
 *
 * @example
 * ```typescript
 * const client = new PnpmRegistryClient({projectDir: '/path/to/project'});
 * const versions = await client.getVersions('@scope/package');
 * const result = await client.downloadPackage('@scope/package', '1.0.0', '/tmp');
 * ```
 */
export class PnpmRegistryClient implements RegistryClient {
  private readonly logger?: Logger;
  private readonly projectDir: string;
  private readonly timeout: number;

  constructor(config: PnpmRegistryClientConfig) {
    this.projectDir = config.projectDir;
    this.logger = config.logger;
    this.timeout = config.timeout ?? 60_000;
  }

  /**
   * Get the registry URL that pnpm resolves for this project.
   * Falls back to the default npm registry if pnpm config isn't available.
   */
  public getRegistryUrl(): string {
    try {
      const registry = execSync('pnpm config get registry', {
        cwd: this.projectDir,
        encoding: 'utf8',
        timeout: 10_000,
      }).trim();
      return registry || 'https://registry.npmjs.org';
    } catch {
      return 'https://registry.npmjs.org';
    }
  }

  /**
   * Get available versions for a package.
   */
  public async getVersions(packageName: string): Promise<string[]> {
    try {
      const output = execSync(
        `pnpm view ${shellEscape(packageName)} versions --json`,
        {cwd: this.projectDir, encoding: 'utf8', timeout: this.timeout},
      );
      const parsed = JSON.parse(output);
      // pnpm view returns a string for single version, array for multiple
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch (error) {
      this.logger?.debug(`Failed to fetch versions for ${packageName}: ${errorMessage(error)}`);
      return [];
    }
  }

  /**
   * Get full package info including version metadata.
   */
  public async getPackageInfo(packageName: string): Promise<RegistryPackageInfo | undefined> {
    try {
      const output = execSync(
        `pnpm view ${shellEscape(packageName)} --json`,
        {cwd: this.projectDir, encoding: 'utf8', timeout: this.timeout},
      );
      const data = JSON.parse(output);

      // pnpm view returns an array when there are multiple versions matching,
      // or a single object for exact match. Normalize to build full info.
      const entries = Array.isArray(data) ? data : [data];
      const versions = entries.map((e: any) => e.version as string);
      const latest = entries.find((e: any) => e['dist-tags']?.latest)?.['dist-tags']?.latest
        ?? versions[versions.length - 1];

      const versionData: Record<string, RegistryVersionInfo> = {};
      for (const entry of entries) {
        if (entry.version && entry.dist?.tarball) {
          versionData[entry.version] = {
            integrity: entry.dist.integrity,
            shasum: entry.dist.shasum,
            tarballUrl: entry.dist.tarball,
            version: entry.version,
          };
        }
      }

      return {latest, name: packageName, versionData, versions};
    } catch (error) {
      this.logger?.debug(`Package not found: ${packageName}: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /**
   * Download a specific version of a package to a target directory.
   *
   * Uses `pnpm pack` which downloads the tarball from the registry
   * respecting all `.npmrc` auth and proxy configuration.
   */
  public async downloadPackage(
    packageName: string,
    version: string,
    targetDir: string,
  ): Promise<DownloadResult> {
    await fs.ensureDir(targetDir);

    try {
      // pnpm pack <pkg>@<version> writes a tarball to --pack-destination
      const output = execSync(
        `pnpm pack ${shellEscape(packageName)}@${shellEscape(version)} --pack-destination ${shellEscape(targetDir)}`,
        {cwd: this.projectDir, encoding: 'utf8', timeout: this.timeout},
      ).trim();

      // pnpm pack prints the tarball filename on the last line
      const tarballName = output.split('\n').pop()?.trim();
      if (!tarballName) {
        throw new Error('pnpm pack did not return a tarball filename');
      }

      const tarballPath = path.join(targetDir, tarballName);

      if (!await fs.pathExists(tarballPath)) {
        throw new Error(`Expected tarball not found at ${tarballPath}`);
      }

      this.logger?.debug(`Downloaded ${packageName}@${version} to ${tarballPath}`);

      return {tarballPath};
    } catch (error) {
      throw new Error(
        `Failed to download ${packageName}@${version}: ${errorMessage(error)}`,
        {cause: error instanceof Error ? error : undefined},
      );
    }
  }

  /**
   * Check if a package exists in the registry.
   */
  public async packageExists(packageName: string): Promise<boolean> {
    try {
      execSync(
        `pnpm view ${shellEscape(packageName)} version`,
        {cwd: this.projectDir, encoding: 'utf8', stdio: 'pipe', timeout: this.timeout},
      );
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface PnpmRegistryClientConfig {
  /** Logger instance */
  logger?: Logger;
  /** Absolute path to the project root (for .npmrc resolution) */
  projectDir: string;
  /** Command timeout in milliseconds (default: 60 000) */
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Escape a string for safe use in a shell command. */
function shellEscape(s: string): string {
  // Wrap in single quotes, escaping any single quotes in the value
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Extract a message from an unknown error. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
