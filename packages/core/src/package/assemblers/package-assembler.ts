import * as fs from 'fs-extra';
import crypto from 'node:crypto';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../project/project-definition-provider.js';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {DestructiveManifestStep} from './steps/destructive-manifest-step.js';
import {ForceIgnoreStep} from './steps/force-ignore-step.js';
import {OrgDefinitionStep} from './steps/org-definition-step.js';
import {ProjectJsonAssemblyStep} from './steps/project-json-assembly-step.js';
import {ScriptAssemblyStep} from './steps/script-assembly-step.js';
import {SeedMetadataStep} from './steps/seed-metadata-step.js';
import {SourceCopyStep} from './steps/source-copy-step.js';
import {UnpackagedMetadataStep} from './steps/unpackaged-metadata-step.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from './types.js';
// import { MDAPIConversionStep } from './steps/mdapi-conversion-step.js';

const DOT_FOLDER = '.sfpm';
/**
 * @description Assembles package contents from a project configuration in a fluent, instance-based manner.
 *
 * ### Staging Area ("The Why")
 * The `PackageAssembler` creates a temporary, isolated "staging area" for each build. This isolation:
 * 1. **Prevents Interference**: Multiple concurrent builds won't corrupt each other's files.
 * 2. **Ensures Determinism**: The resulting artifact contains exactly what is specified, with no leftover files from previous runs.
 * 3. **Simplifies Packaging**: Tools can simply zip or upload the entire contents of the staging directory.
 *
 * ### Staging Structure ("The How")
 * The staging area follows a standardized layout:
 * - `/[packagePath]`: Primary source metadata.
 * - `/unpackagedMetadata`: Supplemental metadata not part of the main package.
 * - `/scripts`: Pre and post-deployment scripts.
 * - `/forceignores`: Stage-specific ignore files (e.g., `.forceignore.validate`).
 * - `.forceignore`: The root ignore file used for the final artifact.
 * - `sfdx-project.json`: A pruned version of the original manifest, specifically for this package.
 *
 * @example
 * ```typescript
 * const stagingPath = await new PackageAssembler(projectConfig, 'my-package', logger)
 *     .withVersion('1.2.3.4')
 *     .withOrgDefinition('config/project-scratch-def.json')
 *     .assemble();
 * ```
 */
export default class PackageAssembler {
  private stagingDirectory: string;

  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private options: AssemblyOptions = {},
    private logger?: Logger,
  ) {
    this.stagingDirectory = this.initializeStagingArea();
  }

  /**
   * @description Orchestrates the package assembly process. This method executes all necessary file I/O operations,
   * including copying source code, handling scripts, generating manifests, and managing
   * the staging area lifecycle.
   *
   * @returns {Promise<string>} A promise that resolves to the absolute path of the created staging directory.
   * @throws {Error} if any step of the assembly process fails.
   *
   * @example
   * ```typescript
   * const stagingPath = await assembler.assemble();
   * console.log(`Package assembled at: ${stagingPath}`);
   * ```
   */
  public async assemble(): Promise<AssemblyOutput> {
    try {
      await this.ensureStagingDirectoryExists();

      const output: AssemblyOutput = {
        projectDefinitionPath: path.join(this.stagingDirectory, 'sfdx-project.json'),
        stagingDirectory: this.stagingDirectory,
      };

      const packageDefinition = this.provider.getPackageDefinition(this.packageName);
      const packageType = packageDefinition.type?.toLowerCase();

      const steps = packageType === PackageType.Data
        ? this.buildDataAssemblySteps()
        : this.buildMetadataAssemblySteps();

      for (const step of steps) {
        this.logger?.debug(`Executing step: ${step.constructor.name}`);
        // eslint-disable-next-line no-await-in-loop -- steps must be executed sequentially as they depend on the output of previous steps
        await step.execute(this.options, output);
      }

      return output;
    } catch (error) {
      // Error Handling: attempt to delete the stagingDirectory before re-throwing
      if (process.env.DEBUG !== 'true' && this.stagingDirectory) {
        await fs.remove(this.stagingDirectory).catch(() => { });
      }

      throw error;
    }
  }

  /**
   * @description Specifies the path to a destructive changes manifest (e.g., destructiveChanges.xml)
   * to be included in the package assembly.
   *
   * @param {string | undefined} path Relative or absolute path to the destructive changes manifest.
   * @returns {this} The PackageAssembler instance for chaining.
   *
   * @example
   * ```typescript
   * assembler.withDestructiveManifest('manifest/destructiveChanges.xml');
   * ```
   */
  public withDestructiveManifest(path: string | undefined): this {
    this.options.destructiveManifestPath = path;
    return this;
  }

  /**
   * @description Specifies the path to an organization definition file (e.g., scratch org definition)
   * to be included in the package assembly.
   *
   * @param {string | undefined} path Relative or absolute path to the org definition JSON.
   * @returns {this} The PackageAssembler instance for chaining.
   *
   * @example
   * ```typescript
   * assembler.withOrgDefinition('config/project-scratch-def.json');
   * ```
   */
  public withOrgDefinition(path: string | undefined): this {
    this.options.orgDefinitionPath = path;
    return this;
  }

  /**
   * @description Overrides the default .forceignore file with a specific replacement file.
   *
   * @param {string | undefined} path Relative or absolute path to the replacement .forceignore file.
   * @returns {this} The PackageAssembler instance for chaining.
   *
   * @example
   * ```typescript
   * assembler.withReplacementForceIgnore('.forceignore.prod');
   * ```
   */
  public withReplacementForceIgnore(path: string | undefined): this {
    this.options.replacementForceignorePath = path;
    return this;
  }

  /**
   * @description Sets the package version number to be injected into the assembly's sfdx-project.json.
   *
   * @param {string | undefined} version The version string (e.g., "1.2.0.1" or "1.2.0.NEXT").
   * @returns {this} The PackageAssembler instance for chaining.
   *
   * @example
   * ```typescript
   * assembler.withVersion('1.0.0.NEXT');
   * ```
   */
  public withVersion(version: string | undefined): this {
    this.options.versionNumber = version;
    return this;
  }

  /**
   * Assembly pipeline for data packages.
   * Content-agnostic: copies the entire package directory as-is.
   * Skips metadata-specific steps (ForceIgnore, UnpackagedMetadata, DestructiveManifest, OrgDefinition).
   */
  private buildDataAssemblySteps(): AssemblyStep[] {
    return [
      new SourceCopyStep(this.packageName, this.provider, this.logger),
      new ScriptAssemblyStep(this.packageName, this.provider, this.logger),
      new ProjectJsonAssemblyStep(this.packageName, this.provider, this.logger),
    ];
  }

  /**
   * Assembly pipeline for metadata packages (source, unlocked).
   * Full pipeline with metadata-specific steps.
   */
  private buildMetadataAssemblySteps(): AssemblyStep[] {
    const steps: AssemblyStep[] = [
      new SourceCopyStep(this.packageName, this.provider, this.logger),
      new OrgDefinitionStep(this.packageName, this.provider, this.logger),
      new ScriptAssemblyStep(this.packageName, this.provider, this.logger),
      new UnpackagedMetadataStep(this.packageName, this.provider, this.logger),
      new SeedMetadataStep(this.packageName, this.provider, this.logger),
      new ForceIgnoreStep(this.packageName, this.provider, this.logger),
    ];

    if (this.options.destructiveManifestPath) {
      steps.push(new DestructiveManifestStep(this.packageName, this.provider, this.logger));
    }

    // always final
    steps.push(new ProjectJsonAssemblyStep(this.packageName, this.provider, this.logger));

    return steps;
  }

  /**
   * @description Generates a unique name for the build to avoid collisions.
   * Format: YYYYMMDDHHMMSS-[packageName]-[randomHash]
   *
   * @returns {string} A unique build identifier.
   */
  private createBuildName(): string {
    const now = new Date();
    const timestamp = now.toISOString()
    .replace(/T/, '-')
    .replace(/\..+/, '')
    .replaceAll(':', '')
    .replaceAll('-', '');

    const hash = crypto.randomBytes(2).toString('hex');
    return `${timestamp}-${this.packageName}-${hash}`;
  }

  /**
   * @description Ensures the parent directories for the staging area exist and that the
   * specific staging folder is completely empty and ready for a fresh build.
   *
   * @returns {Promise<void>}
   */
  private async ensureStagingDirectoryExists(): Promise<void> {
    await fs.ensureDir(path.dirname(this.stagingDirectory));
    await fs.emptyDir(this.stagingDirectory);
  }

  /**
   * @description Resolves the path for the temporary assembly area.
   * The path is constructed as: `.sfpm/tmp/builds/[timestamp]-[packageName]-[hash]`
   * Uses the project root (where sfdx-project.json lives) rather than cwd so that
   * the staging area is never created inside a package's own source directory
   * (which would cause SourceCopyStep to fail with a self-referencing copy).
   *
   * @returns {string} The absolute path to the staging directory.
   */
  private initializeStagingArea(): string {
    const buildName = this.createBuildName();
    return path.join(this.provider.projectDir, DOT_FOLDER, 'tmp', 'builds', buildName, 'package');
  }
}
