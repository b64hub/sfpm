import type {Logger} from '@b64/sfpm-core';

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ============================================================================
// Types
// ============================================================================

/**
 * Per-package build state persisted across jobs.
 *
 * Captures everything needed by the resume step to pick up
 * validation polling for unlocked packages.
 */
export interface PackageBuildState {
  /** Relative path to artifact tarball (from project root) */
  artifactPath?: string;
  /** Whether this package needs async validation polling */
  needsValidation: boolean;
  /** Package name */
  packageName: string;
  /** Package type (Unlocked, Source, Data) */
  packageType: string;
  /** Package2VersionCreateRequest ID — used to poll async validation status */
  packageVersionCreateRequestId?: string;
  /** Subscriber package version ID (04t...) — set after creation */
  packageVersionId?: string;
  /** Whether the build was skipped (no source changes) */
  skipped: boolean;
  /** Whether this package built successfully */
  success: boolean;
  /** Resolved version number (e.g., 1.0.0-1) */
  version?: string;
}

/**
 * Full build state cached between the build and resume jobs.
 *
 * Stored as JSON in the GitHub Actions cache, keyed by run ID.
 */
export interface CachedBuildState {
  /** Artifact base directory (relative to project root) */
  artifactsDir: string;
  /** When this cache entry was created */
  cachedAt: number;
  /** DevHub username used for unlocked package builds */
  devhubUsername?: string;
  /** Per-package build outcomes */
  packages: PackageBuildState[];
  /** Project directory */
  projectDir: string;
  /** GitHub Actions run ID for cache scoping */
  runId: string;
}

export interface BuildCacheOptions {
  /** Cache key prefix (default: 'sfpm-build') */
  cacheKeyPrefix?: string;
  /** Logger instance */
  logger?: Logger;
  /** GitHub Actions run ID */
  runId: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_CACHE_KEY_PREFIX = 'sfpm-build';
const CACHE_FILE_NAME = 'sfpm-build-state.json';

// ============================================================================
// BuildCacheService
// ============================================================================

/**
 * Manages cached build state between the `build` and `build-resume` jobs.
 *
 * Uses `@actions/cache` to persist a JSON file containing per-package
 * build outcomes (version IDs, artifact paths, validation status).
 * The resume job restores this state to poll for async validation
 * completion on unlocked packages.
 *
 * Cache keys are scoped by the GitHub Actions run ID so that
 * parallel workflow runs don't collide.
 *
 * @example
 * ```typescript
 * // In build job:
 * const buildCache = new BuildCacheService({ runId: github.context.runId.toString(), logger });
 * await buildCache.save(buildState);
 *
 * // In resume job:
 * const buildCache = new BuildCacheService({ runId: github.context.runId.toString(), logger });
 * const state = await buildCache.restore();
 * ```
 */
export class BuildCacheService {
  private readonly cacheDir: string;
  private readonly cacheKeyPrefix: string;
  private readonly logger?: Logger;
  private readonly runId: string;

  constructor(options: BuildCacheOptions) {
    this.runId = options.runId;
    this.cacheKeyPrefix = options.cacheKeyPrefix ?? DEFAULT_CACHE_KEY_PREFIX;
    this.logger = options.logger;
    this.cacheDir = path.join(os.tmpdir(), 'sfpm-build-cache');
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Restore cached build state for this workflow run.
   *
   * Returns `undefined` if no cache exists for the current run ID.
   */
  public async restore(): Promise<CachedBuildState | undefined> {
    const cacheKey = this.buildCacheKey();
    const restoreKeys = this.buildRestoreKeys();
    const cachePath = this.getCacheFilePath();

    this.logger?.debug(`Attempting to restore build cache for run ${this.runId}`);
    this.logger?.debug(`Cache key: ${cacheKey}, restore keys: ${restoreKeys.join(', ')}`);

    try {
      await fs.promises.mkdir(this.cacheDir, {recursive: true});

      const hitKey = await cache.restoreCache([this.cacheDir], cacheKey, restoreKeys);
      if (!hitKey) {
        this.logger?.info(`No cached build state found for run ${this.runId}`);
        return undefined;
      }

      this.logger?.debug(`Cache hit with key: ${hitKey}`);

      if (!fs.existsSync(cachePath)) {
        this.logger?.warn('Cache key hit but state file not found');
        return undefined;
      }

      const raw = await fs.promises.readFile(cachePath, 'utf8');
      const state: CachedBuildState = JSON.parse(raw);

      this.logger?.info(`Restored build state for run ${this.runId}: `
        + `${state.packages.length} package(s), `
        + `${state.packages.filter(p => p.needsValidation).length} pending validation`);

      return state;
    } catch (error) {
      this.logger?.warn(`Failed to restore build cache: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  /**
   * Save build state to the cache for this workflow run.
   *
   * Should be called at the end of the build job after all packages
   * have been built and artifacts assembled.
   */
  public async save(state: CachedBuildState): Promise<void> {
    const cachePath = this.getCacheFilePath();
    const cacheKey = this.buildSaveKey();

    this.logger?.debug(`Saving build cache for run ${this.runId} with key: ${cacheKey}`);

    try {
      await fs.promises.mkdir(this.cacheDir, {recursive: true});
      await fs.promises.writeFile(cachePath, JSON.stringify(state, null, 2));

      await cache.saveCache([this.cacheDir], cacheKey);
      this.logger?.info(`Cached build state for run ${this.runId}: `
        + `${state.packages.length} package(s)`);
    } catch (error) {
      if (error instanceof cache.ReserveCacheError) {
        this.logger?.debug(`Cache already exists for key ${cacheKey}, skipping save`);
      } else {
        this.logger?.warn(`Failed to save build cache: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Outputs
  // --------------------------------------------------------------------------

  /**
   * Set GitHub Actions outputs for the build state.
   */
  public setOutputs(state: CachedBuildState): void {
    core.setOutput('run-id', state.runId);
    core.setOutput('packages-built', state.packages.filter(p => p.success).length);
    core.setOutput('packages-pending-validation', state.packages.filter(p => p.needsValidation).length);
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Primary cache key for exact match.
   */
  private buildCacheKey(): string {
    return `${this.cacheKeyPrefix}-${this.runId}`;
  }

  /**
   * Restore keys for prefix-based fallback match.
   */
  private buildRestoreKeys(): string[] {
    return [`${this.cacheKeyPrefix}-${this.runId}-`];
  }

  /**
   * Save key includes a timestamp suffix since GitHub Actions
   * cache entries are immutable.
   */
  private buildSaveKey(): string {
    return `${this.cacheKeyPrefix}-${this.runId}-${Date.now()}`;
  }

  private getCacheFilePath(): string {
    return path.join(this.cacheDir, CACHE_FILE_NAME);
  }
}
