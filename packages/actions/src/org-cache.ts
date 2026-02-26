import * as cache from '@actions/cache';
import * as core from '@actions/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {Logger} from '@b64/sfpm-core';

// ============================================================================
// Types
// ============================================================================

/**
 * Cached scratch org connection info.
 *
 * Stored as JSON in the GitHub Actions cache, keyed by PR number.
 * Contains everything needed to re-authenticate without consuming
 * another org from the pool.
 */
export interface CachedOrgConnection {
    /** When this cache entry was created */
    cachedAt: number;
    /** TTL in milliseconds for this cache entry */
    cacheTtlMs: number;
    /** The org ID (00D...) */
    orgId: string;
    /** PR number this org is assigned to */
    prNumber: number;
    /** Scratch org auth URL (sfdxAuthUrl format) */
    sfdxAuthUrl: string;
    /** Scratch org username */
    username: string;
}

export interface OrgCacheOptions {
    /** Cache key prefix (default: 'sfpm-org') */
    cacheKeyPrefix?: string;
    /** Time-to-live for cached orgs in hours (default: 4) */
    cacheTtlHours?: number;
    /** Logger instance */
    logger?: Logger;
    /** PR number to scope the cache to */
    prNumber: number;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CACHE_TTL_HOURS = 4;
const DEFAULT_CACHE_KEY_PREFIX = 'sfpm-org';
const CACHE_FILE_NAME = 'sfpm-org-cache.json';

// ============================================================================
// OrgCacheService
// ============================================================================

/**
 * Manages cached scratch org connections scoped to a PR.
 *
 * Uses `@actions/cache` to persist a JSON file mapping a PR number
 * to a scratch org connection. This avoids consuming a fresh org from
 * the pool on every push to the same PR.
 *
 * The cache has a configurable TTL (default: 4 hours). When the TTL
 * expires, `restore()` returns `undefined` and the caller should fetch
 * a new org from the pool and call `save()` to cache it.
 *
 * Cache keys are versioned with a timestamp-based suffix so that
 * `save()` always creates a fresh entry (GitHub Actions cache is
 * immutable — you can't overwrite an existing key).
 *
 * @example
 * ```typescript
 * const orgCache = new OrgCacheService({
 *   prNumber: 42,
 *   cacheTtlHours: 6,
 *   logger,
 * });
 *
 * let connection = await orgCache.restore();
 * if (!connection) {
 *   const org = await poolService.fetch({ tag: 'dev-pool' });
 *   connection = { username: org.auth.username, sfdxAuthUrl: org.auth.authUrl!, ... };
 *   await orgCache.save(connection);
 * }
 * ```
 */
export class OrgCacheService {
    private readonly cacheDir: string;
    private readonly cacheKeyPrefix: string;
    private readonly cacheTtlMs: number;
    private readonly logger?: Logger;
    private readonly prNumber: number;

    constructor(options: OrgCacheOptions) {
        this.prNumber = options.prNumber;
        this.cacheTtlMs = (options.cacheTtlHours ?? DEFAULT_CACHE_TTL_HOURS) * 60 * 60 * 1000;
        this.cacheKeyPrefix = options.cacheKeyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;
        this.logger = options.logger;
        this.cacheDir = path.join(os.tmpdir(), 'sfpm-org-cache');
    }

    // --------------------------------------------------------------------------
    // Public API
    // --------------------------------------------------------------------------

    /**
     * Attempt to restore a cached org connection for this PR.
     *
     * Returns `undefined` if no cache exists or if the cached entry
     * has expired (TTL exceeded).
     */
    public async restore(): Promise<CachedOrgConnection | undefined> {
        const cacheKey = this.buildCacheKey();
        const restoreKeys = this.buildRestoreKeys();
        const cachePath = this.getCacheFilePath();

        this.logger?.debug(`Attempting to restore org cache for PR #${this.prNumber}`);
        this.logger?.debug(`Cache key: ${cacheKey}, restore keys: ${restoreKeys.join(', ')}`);

        try {
            await fs.promises.mkdir(this.cacheDir, {recursive: true});

            const hitKey = await cache.restoreCache([this.cacheDir], cacheKey, restoreKeys);
            if (!hitKey) {
                this.logger?.info(`No cached org found for PR #${this.prNumber}`);
                return undefined;
            }

            this.logger?.debug(`Cache hit with key: ${hitKey}`);

            if (!fs.existsSync(cachePath)) {
                this.logger?.warn('Cache key hit but cache file not found');
                return undefined;
            }

            const raw = await fs.promises.readFile(cachePath, 'utf8');
            const connection: CachedOrgConnection = JSON.parse(raw);

            // Check TTL
            const age = Date.now() - connection.cachedAt;
            if (age > connection.cacheTtlMs) {
                this.logger?.info(
                    `Cached org for PR #${this.prNumber} has expired ` +
                    `(age: ${Math.round(age / 1000 / 60)}m, TTL: ${Math.round(connection.cacheTtlMs / 1000 / 60)}m)`,
                );
                return undefined;
            }

            this.logger?.info(
                `Restored cached org ${connection.username} for PR #${this.prNumber} ` +
                `(age: ${Math.round(age / 1000 / 60)}m)`,
            );

            return connection;
        } catch (error) {
            this.logger?.warn(`Failed to restore org cache: ${error instanceof Error ? error.message : String(error)}`);
            return undefined;
        }
    }

    /**
     * Save a scratch org connection to the cache for this PR.
     *
     * The connection is written as JSON and cached with a timestamped
     * key so it can be restored on subsequent workflow runs.
     */
    public async save(connection: Omit<CachedOrgConnection, 'cachedAt' | 'cacheTtlMs' | 'prNumber'>): Promise<void> {
        const entry: CachedOrgConnection = {
            ...connection,
            cachedAt: Date.now(),
            cacheTtlMs: this.cacheTtlMs,
            prNumber: this.prNumber,
        };

        const cachePath = this.getCacheFilePath();
        const cacheKey = this.buildSaveKey();

        this.logger?.debug(`Saving org cache for PR #${this.prNumber} with key: ${cacheKey}`);

        try {
            await fs.promises.mkdir(this.cacheDir, {recursive: true});
            await fs.promises.writeFile(cachePath, JSON.stringify(entry, null, 2));

            await cache.saveCache([this.cacheDir], cacheKey);
            this.logger?.info(`Cached org ${connection.username} for PR #${this.prNumber}`);
        } catch (error) {
            // Cache save failures are non-fatal — log and continue.
            // Common cause: another job already saved with this key.
            if (error instanceof cache.ReserveCacheError) {
                this.logger?.debug(`Cache already exists for key ${cacheKey}, skipping save`);
            } else {
                this.logger?.warn(`Failed to save org cache: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    // --------------------------------------------------------------------------
    // Outputs
    // --------------------------------------------------------------------------

    /**
     * Set GitHub Actions outputs for the cached connection.
     * Makes username, orgId, etc. available to downstream steps.
     */
    public setOutputs(connection: CachedOrgConnection): void {
        core.setOutput('org-username', connection.username);
        core.setOutput('org-id', connection.orgId);
        core.setOutput('cache-hit', 'true');
        core.setOutput('cache-age-minutes', Math.round((Date.now() - connection.cachedAt) / 1000 / 60));
    }

    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------

    /**
     * Primary cache key — exact match for this PR.
     * Does not include a timestamp so `restoreCache` can find any
     * previous save for this PR via the restore keys.
     */
    private buildCacheKey(): string {
        return `${this.cacheKeyPrefix}-pr-${this.prNumber}`;
    }

    /**
     * Restore keys — prefix match allows finding the latest save
     * even when the exact key (with timestamp) differs.
     */
    private buildRestoreKeys(): string[] {
        return [`${this.cacheKeyPrefix}-pr-${this.prNumber}-`];
    }

    /**
     * Save key — includes a timestamp suffix because GitHub Actions
     * cache entries are immutable (can't overwrite).
     */
    private buildSaveKey(): string {
        return `${this.cacheKeyPrefix}-pr-${this.prNumber}-${Date.now()}`;
    }

    private getCacheFilePath(): string {
        return path.join(this.cacheDir, CACHE_FILE_NAME);
    }
}
