import fs from 'fs-extra';
import ignore from 'ignore';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * Copies the primary package directory to the staging area.
 *
 * Always excludes `node_modules` and `.sfpm` from the copy — these are never
 * part of a Salesforce package and may contain broken symlinks (e.g. pnpm
 * workspace links) that would cause downstream tools to fail.
 *
 * When a build-stage ignore file is configured (via `ignoreFilesConfig.build`),
 * its patterns are applied as an additional filter during the copy so that
 * excluded metadata never reaches the staged artifact.  The ignore file uses
 * the same `.gitignore`-style syntax that `.forceignore` supports.
 */
export class SourceCopyStep implements AssemblyStep {
  /** Directories that are never part of a Salesforce package */
  private static readonly ALWAYS_EXCLUDED = new Set(['.sfpm', 'node_modules']);
  /**
   * Files excluded from the source copy.
   *
   * `package.json` is excluded because it lives at the package root (one level
   * above the SF source path in workspace mode). The artifact's package.json
   * is generated separately by `ArtifactAssembler.generatePackageJson`, which
   * reads the workspace package.json and overlays build-time metadata.
   */
  private static readonly IGNORED_FILES = new Set(['package.json']);

  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) {}

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.provider.getPackageDefinition(this.packageName);
    const sourceDir = path.join(this.provider.projectDir, packageDefinition.path);
    const destinationDir = path.join(output.stagingDirectory, packageDefinition.path);

    const ig = await this.loadBuildIgnore(options);

    if (ig) {
      this.logger?.debug(`[SourceCopyStep] Copying from ${sourceDir} to ${destinationDir} (with build ignore filter)`);
    } else {
      this.logger?.debug(`[SourceCopyStep] Copying from ${sourceDir} to ${destinationDir}`);
    }

    try {
      await fs.copy(sourceDir, destinationDir, {
        filter: (src: string) => {
          // Always include the root source directory itself
          const relativePath = path.relative(sourceDir, src);
          if (!relativePath) {
            return true;
          }

          // Exclude directories that are never part of a Salesforce package
          const topSegment = relativePath.split(path.sep)[0];
          if (SourceCopyStep.ALWAYS_EXCLUDED.has(topSegment)) {
            return false;
          }

          // Exclude specific files handled by other assembly steps
          const fileName = path.basename(relativePath);
          if (SourceCopyStep.IGNORED_FILES.has(fileName)) {
            this.logger?.debug(`[SourceCopyStep] Excluded by ignored files: ${relativePath}`);
            return false;
          }

          if (!ig) {
            return true;
          }

          // The `ignore` library requires a trailing slash for directory-only
          // patterns (e.g. "testClasses/") to match the directory entry itself.
          // Without this, fs.copy would create the empty directory before
          // filtering its children.
          const isDir = fs.statSync(src).isDirectory();
          const testPath = isDir ? `${relativePath}/` : relativePath;
          const ignored = ig.ignores(testPath);

          if (ignored) {
            this.logger?.debug(`[SourceCopyStep] Excluded by build ignore: ${relativePath}`);
          }

          return !ignored;
        },
      });
    } catch (error: any) {
      throw new Error(`[SourceCopyStep] Failed to copy source: ${error.message}`);
    }
  }

  /**
   * Load and parse the build-stage ignore file, if configured.
   * Returns `null` when no build ignore file is configured or the file does not exist.
   */
  private async loadBuildIgnore(options: AssemblyOptions): Promise<null | ReturnType<typeof ignore>> {
    const buildIgnorePath = options.ignoreFilesConfig?.build;
    if (!buildIgnorePath) {
      return null;
    }

    const resolvedPath = path.resolve(this.provider.projectDir, buildIgnorePath);

    if (!await fs.pathExists(resolvedPath)) {
      this.logger?.warn(`[SourceCopyStep] Build ignore file not found: ${resolvedPath}`);
      return null;
    }

    const content = await fs.readFile(resolvedPath, 'utf8');
    this.logger?.debug(`[SourceCopyStep] Loaded build ignore from ${resolvedPath}`);
    return ignore().add(content);
  }
}
