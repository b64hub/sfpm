import path from 'path';
import fs from 'fs-extra';
import { BuildTask } from "../../package-builder.js";
import SfpmPackage, { SfpmMetadataPackage } from "../../sfpm-package.js";
import { SourceHasher } from "../../../utils/source-hasher.js";
import { Logger } from "../../../types/logger.js";
import { ArtifactManifest } from "../../../types/artifact.js";

/**
 * Source hash validation task that checks if a build is necessary.
 * 
 * This task:
 * 1. Validates that the package has components (prevents empty package builds)
 * 2. Calculates the current source hash
 * 3. Compares against the latest version in manifest.json
 * 4. Throws an error if no build is needed (idempotency check)
 * 
 * This prevents expensive build operations (package version creation, tests, etc.) 
 * when the source hasn't changed.
 */
export default class SourceHashTask implements BuildTask {
    private sfpmPackage: SfpmPackage;
    private projectDirectory: string;
    private logger?: Logger;

    public constructor(sfpmPackage: SfpmPackage, projectDirectory: string, logger?: Logger) {
        this.sfpmPackage = sfpmPackage;
        this.projectDirectory = projectDirectory;
        this.logger = logger;
    }

    public async exec(): Promise<void> {
        // Only perform checks for metadata packages
        if (!(this.sfpmPackage instanceof SfpmMetadataPackage)) {
            this.logger?.debug('Skipping source hash check for non-metadata package');
            return;
        }

        // 1. Validate that the package has components
        const componentSet = this.sfpmPackage.getComponentSet();
        const components = componentSet.getSourceComponents().toArray();
        
        if (components.length === 0) {
            throw new Error(
                `Cannot build package '${this.sfpmPackage.packageName}': Package contains no metadata components. ` +
                `Ensure the package directory contains valid Salesforce metadata.`
            );
        }

        this.logger?.debug(`Package contains ${components.length} components`);

        // 2. Calculate current source hash
        const currentSourceHash = await SourceHasher.calculate(this.sfpmPackage);
        this.logger?.debug(`Current source hash: ${currentSourceHash}`);

        // 3. Check manifest for previous builds
        const artifactsRootDir = path.join(this.projectDirectory, 'artifacts');
        const manifestPath = path.join(artifactsRootDir, this.sfpmPackage.packageName, 'manifest.json');

        if (!(await fs.pathExists(manifestPath))) {
            this.logger?.info('No previous builds found, proceeding with build');
            return;
        }

        const manifest: ArtifactManifest = await fs.readJson(manifestPath);
        const latestVersion = manifest.versions[manifest.latest];

        if (!latestVersion) {
            this.logger?.info('No latest version found in manifest, proceeding with build');
            return;
        }

        // 4. Compare source hashes
        if (latestVersion.sourceHash === currentSourceHash) {
            const message = 
                `Build skipped for '${this.sfpmPackage.packageName}': No source changes detected.\n` +
                `Latest version: ${manifest.latest}\n` +
                `Source hash: ${currentSourceHash}\n` +
                `Artifact: ${latestVersion.path}`;
            
            this.logger?.info(message);
            
            // Throw a special error that can be caught and handled gracefully
            const error = new Error(message) as any;
            error.code = 'BUILD_NOT_REQUIRED';
            error.latestVersion = manifest.latest;
            error.artifactPath = latestVersion.path;
            throw error;
        }

        this.logger?.info('Source changes detected, proceeding with build');
        if (latestVersion.sourceHash) {
            this.logger?.debug(`Previous hash: ${latestVersion.sourceHash}`);
            this.logger?.debug(`Current hash:  ${currentSourceHash}`);
        }
    }
}
