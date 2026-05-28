import fs from 'fs-extra';
import path from 'node:path';

import {ArtifactManifest} from '../../../types/artifact.js';
import {Logger} from '../../../types/logger.js';
import SfpmPackage, {SfpmMetadataPackage} from '../../sfpm-package.js';
import {BuildTask, BuildTaskContext, BuildTaskResult} from '../builder-registry.js';

/**
 * Source hash validation task that checks if a build is necessary.
 *
 * This task:
 * 1. Validates that the package has components (prevents empty package builds)
 * 2. Calculates the current source hash
 * 3. Compares against the latest version in manifest.json
 * 4. Returns a skip result if no build is needed (idempotency check)
 *
 * This prevents expensive build operations (package version creation, tests, etc.)
 * when the source hasn't changed.
 */
class SourceHashTask implements BuildTask {
  public readonly name = 'source-hash';
  private readonly logger?: Logger;
  private readonly projectDirectory: string;
  private readonly sfpmPackage: SfpmPackage;

  public constructor(ctx: BuildTaskContext) {
    this.sfpmPackage = ctx.sfpmPackage;
    this.projectDirectory = ctx.projectDirectory;
    this.logger = ctx.logger;
  }

  public canRun(): boolean {
    return this.sfpmPackage instanceof SfpmMetadataPackage;
  }

  public async exec(): Promise<BuildTaskResult | void> {
    if (!(this.sfpmPackage instanceof SfpmMetadataPackage)) {
      return;
    }

    // 1. Validate that the package has components
    const componentSet = this.sfpmPackage.getComponentSet();
    const components = componentSet.getSourceComponents().toArray();

    if (components.length === 0) {
      throw new Error(`Cannot build package '${this.sfpmPackage.packageName}': Package contains no metadata components. `
        + 'Ensure the package directory contains valid Salesforce metadata.');
    }

    this.logger?.debug(`Package contains ${components.length} components`);

    // 2. Calculate current source hash
    const currentSourceHash = await this.sfpmPackage.calculateSourceHash();
    this.logger?.debug(`Current source hash: ${currentSourceHash}`);

    // 3. Check manifest for previous builds
    const artifactsRootDir = path.join(this.projectDirectory, 'artifacts');
    const manifestPath = path.join(artifactsRootDir, this.sfpmPackage.packageName, 'manifest.json');

    if (!(await fs.pathExists(manifestPath))) {
      this.logger?.info('No previous builds found, proceeding with build');
      return {enrichments: {sourceHash: currentSourceHash}};
    }

    const manifest: ArtifactManifest = await fs.readJson(manifestPath);
    const latestVersion = manifest.versions[manifest.latest];

    if (!latestVersion) {
      this.logger?.info('No latest version found in manifest, proceeding with build');
      return {enrichments: {sourceHash: currentSourceHash}};
    }

    // 4. Compare source hashes
    if (latestVersion.sourceHash === currentSourceHash) {
      this.logger?.info(`Build skipped for '${this.sfpmPackage.packageName}': No source changes detected. `
        + `Latest version: ${manifest.latest}, Source hash: ${currentSourceHash}`);

      return {
        skip: {
          artifactPath: latestVersion.path,
          latestVersion: manifest.latest,
          reason: `No source changes detected for package '${this.sfpmPackage.packageName}'`,
        },
      };
    }

    this.logger?.info('Source changes detected, proceeding with build');
    if (latestVersion.sourceHash) {
      this.logger?.debug(`Previous hash: ${latestVersion.sourceHash}`);
      this.logger?.debug(`Current hash:  ${currentSourceHash}`);
    }

    return {enrichments: {sourceHash: currentSourceHash}};
  }
}

/** Factory for SourceHashTask — no task-specific options needed. */
export function sourceHashTask(): (ctx: BuildTaskContext) => BuildTask {
  return (ctx: BuildTaskContext) => new SourceHashTask(ctx);
}

export default SourceHashTask;
