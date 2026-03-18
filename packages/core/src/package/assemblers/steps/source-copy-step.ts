import fs from 'fs-extra';
import ignore from 'ignore';
import path from 'node:path';

import ProjectConfig from '../../../project/project-config.js';
import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * Copies the primary package directory to the staging area.
 *
 * When a build-stage ignore file is configured (via `ignoreFilesConfig.build`),
 * its patterns are applied as a filter during the copy so that excluded
 * metadata never reaches the staged artifact.  The ignore file uses the
 * same `.gitignore`-style syntax that `.forceignore` supports.
 */
export class SourceCopyStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private projectConfig: ProjectConfig,
    private logger?: Logger,
  ) {}

  public async execute(options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.projectConfig.getPackageDefinition(this.packageName);
    const sourceDir = path.join(this.projectConfig.projectDirectory, packageDefinition.path);
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

    const resolvedPath = path.resolve(this.projectConfig.projectDirectory, buildIgnorePath);

    if (!await fs.pathExists(resolvedPath)) {
      this.logger?.warn(`[SourceCopyStep] Build ignore file not found: ${resolvedPath}`);
      return null;
    }

    const content = await fs.readFile(resolvedPath, 'utf8');
    this.logger?.debug(`[SourceCopyStep] Loaded build ignore from ${resolvedPath}`);
    return ignore().add(content);
  }
}
