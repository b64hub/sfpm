import path from 'path';
import fs from 'fs-extra';
import { pipeline } from 'stream/promises';
import { createWriteStream } from 'fs';
import { Logger } from '../../types/logger.js';
import {
    RegistryClient,
    RegistryClientConfig,
    RegistryPackageInfo,
    RegistryVersionInfo,
    DownloadResult,
} from './registry-client.js';

/**
 * Default npm registry URL
 */
const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/**
 * Default request timeout (30 seconds)
 */
const DEFAULT_TIMEOUT = 30000;

/**
 * npm registry response for package metadata
 */
interface NpmPackageResponse {
    name: string;
    'dist-tags'?: {
        latest?: string;
        [tag: string]: string | undefined;
    };
    versions: {
        [version: string]: {
            name: string;
            version: string;
            dist: {
                tarball: string;
                integrity?: string;
                shasum?: string;
            };
        };
    };
}

/**
 * npm Registry Client implementation.
 * Uses the npm registry HTTP API directly (no subprocess spawning).
 * 
 * @example
 * ```typescript
 * const client = new NpmRegistryClient({
 *     registryUrl: 'https://registry.npmjs.org',
 *     authToken: process.env.NPM_TOKEN,
 * });
 * 
 * const versions = await client.getVersions('@scope/package');
 * const result = await client.downloadPackage('@scope/package', '1.0.0', '/tmp');
 * ```
 */
export class NpmRegistryClient implements RegistryClient {
    private registryUrl: string;
    private authToken?: string;
    private timeout: number;
    private logger?: Logger;

    constructor(config: Partial<RegistryClientConfig> = {}) {
        this.registryUrl = this.normalizeUrl(config.registryUrl || DEFAULT_NPM_REGISTRY);
        this.authToken = config.authToken;
        this.timeout = config.timeout || DEFAULT_TIMEOUT;
        this.logger = config.logger;
    }

    /**
     * Get the registry URL this client is configured for
     */
    public getRegistryUrl(): string {
        return this.registryUrl;
    }

    /**
     * Get available versions for a package
     */
    public async getVersions(packageName: string): Promise<string[]> {
        const packageInfo = await this.getPackageInfo(packageName);
        return packageInfo?.versions || [];
    }

    /**
     * Get full package info including version metadata
     */
    public async getPackageInfo(packageName: string): Promise<RegistryPackageInfo | undefined> {
        try {
            const url = this.buildPackageUrl(packageName);
            this.logger?.debug(`Fetching package info from: ${url}`);

            const response = await fetch(url, {
                headers: this.buildHeaders(),
                signal: AbortSignal.timeout(this.timeout),
            });

            if (response.status === 404) {
                this.logger?.debug(`Package not found: ${packageName}`);
                return undefined;
            }

            if (!response.ok) {
                throw new Error(`Registry returned ${response.status}: ${response.statusText}`);
            }

            const data = await response.json() as NpmPackageResponse;
            return this.transformPackageResponse(data);

        } catch (error) {
            if (error instanceof Error && error.name === 'TimeoutError') {
                this.logger?.warn(`Timeout fetching package info for ${packageName}`);
            } else {
                this.logger?.debug(`Failed to fetch package info for ${packageName}: ${error instanceof Error ? error.message : String(error)}`);
            }
            return undefined;
        }
    }

    /**
     * Download a package tarball to a target directory
     */
    public async downloadPackage(
        packageName: string,
        version: string,
        targetDir: string
    ): Promise<DownloadResult> {
        // Get version info to find tarball URL
        const packageInfo = await this.getPackageInfo(packageName);
        if (!packageInfo) {
            throw new Error(`Package not found: ${packageName}`);
        }

        const versionInfo = packageInfo.versionData?.[version];
        if (!versionInfo) {
            throw new Error(`Version ${version} not found for package ${packageName}`);
        }

        // Ensure target directory exists
        await fs.ensureDir(targetDir);

        // Download tarball
        const tarballPath = path.join(targetDir, 'package.tgz');
        await this.downloadTarball(versionInfo.tarballUrl, tarballPath);

        return {
            tarballPath,
            integrity: versionInfo.integrity,
        };
    }

    /**
     * Check if a package exists in the registry
     */
    public async packageExists(packageName: string): Promise<boolean> {
        try {
            const url = this.buildPackageUrl(packageName);
            const response = await fetch(url, {
                method: 'HEAD',
                headers: this.buildHeaders(),
                signal: AbortSignal.timeout(this.timeout),
            });
            return response.ok;
        } catch {
            return false;
        }
    }

    // =========================================================================
    // Private Methods
    // =========================================================================

    /**
     * Normalize registry URL (remove trailing slashes)
     */
    private normalizeUrl(url: string): string {
        return url.replace(/\/+$/, '');
    }

    /**
     * Build the package metadata URL
     * Handles scoped packages (@scope/name -> @scope%2Fname)
     */
    private buildPackageUrl(packageName: string): string {
        const encodedName = packageName.startsWith('@')
            ? `@${encodeURIComponent(packageName.slice(1))}`
            : encodeURIComponent(packageName);
        return `${this.registryUrl}/${encodedName}`;
    }

    /**
     * Build request headers including auth if configured
     */
    private buildHeaders(): Record<string, string> {
        const headers: Record<string, string> = {
            'Accept': 'application/json',
        };

        if (this.authToken) {
            headers['Authorization'] = `Bearer ${this.authToken}`;
        }

        return headers;
    }

    /**
     * Transform npm registry response to our interface
     */
    private transformPackageResponse(data: NpmPackageResponse): RegistryPackageInfo {
        const versions = Object.keys(data.versions);
        const versionData: Record<string, RegistryVersionInfo> = {};

        for (const [version, versionMeta] of Object.entries(data.versions)) {
            versionData[version] = {
                version,
                tarballUrl: versionMeta.dist.tarball,
                integrity: versionMeta.dist.integrity,
                shasum: versionMeta.dist.shasum,
            };
        }

        return {
            name: data.name,
            versions,
            latest: data['dist-tags']?.latest,
            versionData,
        };
    }

    /**
     * Download a tarball from URL to local path
     */
    private async downloadTarball(url: string, targetPath: string): Promise<void> {
        this.logger?.debug(`Downloading tarball from: ${url}`);

        const response = await fetch(url, {
            headers: this.buildHeaders(),
            signal: AbortSignal.timeout(this.timeout * 4), // Longer timeout for downloads
        });

        if (!response.ok) {
            throw new Error(`Failed to download tarball: ${response.status} ${response.statusText}`);
        }

        if (!response.body) {
            throw new Error('No response body received');
        }

        // Stream the response to file
        const fileStream = createWriteStream(targetPath);
        
        // Convert web stream to node stream and pipe to file
        await pipeline(response.body, fileStream);

        this.logger?.debug(`Tarball downloaded to: ${targetPath}`);
    }
}
