import * as fs from 'fs-extra';
import path from 'node:path';

import type {ProjectDefinitionProvider} from '../../../project/providers/project-definition-provider.js';

import {Logger} from '../../../types/logger.js';
import {AssemblyOptions, AssemblyOutput, AssemblyStep} from '../types.js';

/**
 * Copies pre and post-deployment scripts from the per-package hook config
 * (`packageOptions.hooks.scripts`) into the staging `/scripts` directory.
 *
 * Scripts are organized into `/scripts/pre/` and `/scripts/post/` subdirectories,
 * preserving original filenames.
 *
 * Accepts both string paths and `{ path: string }` objects so users can configure:
 * ```jsonc
 * // sfdx-project.json
 * {
 *   "packageOptions": {
 *     "hooks": {
 *       "scripts": {
 *         "pre": ["scripts/setup.sh"],
 *         "post": ["scripts/seed.ts", "scripts/activate.apex"]
 *       }
 *     }
 *   }
 * }
 * ```
 */
export class ScriptAssemblyStep implements AssemblyStep {
  constructor(
    private packageName: string,
    private provider: ProjectDefinitionProvider,
    private logger?: Logger,
  ) {}

  public async execute(_options: AssemblyOptions, output: AssemblyOutput): Promise<void> {
    const packageDefinition = this.provider.getPackageDefinition(this.packageName);
    const hooksConfig = packageDefinition.packageOptions?.hooks;

    if (!hooksConfig) return;

    const scriptsConfig = hooksConfig.scripts;
    if (!scriptsConfig || typeof scriptsConfig === 'boolean') return;

    const config = scriptsConfig as Record<string, unknown>;
    const preScripts = normalizeScriptPaths(config.pre);
    const postScripts = normalizeScriptPaths(config.post);

    if (preScripts.length === 0 && postScripts.length === 0) return;

    const scriptsDir = path.join(output.stagingDirectory, 'scripts');

    if (preScripts.length > 0) {
      const preDir = path.join(scriptsDir, 'pre');
      await fs.ensureDir(preDir);
      for (const scriptPath of preScripts) {
        // eslint-disable-next-line no-await-in-loop
        await this.copyScript(preDir, scriptPath);
      }

      output.scripts = {...output.scripts, pre: preScripts.map(p => path.join('scripts', 'pre', path.basename(p)))};
    }

    if (postScripts.length > 0) {
      const postDir = path.join(scriptsDir, 'post');
      await fs.ensureDir(postDir);
      for (const scriptPath of postScripts) {
        // eslint-disable-next-line no-await-in-loop
        await this.copyScript(postDir, scriptPath);
      }

      output.scripts = {...output.scripts, post: postScripts.map(p => path.join('scripts', 'post', path.basename(p)))};
    }
  }

  private async copyScript(targetDir: string, scriptPath: string): Promise<void> {
    const resolvedPath = path.isAbsolute(scriptPath)
      ? scriptPath
      : path.join(this.provider.projectDir, scriptPath);

    if (!(await fs.pathExists(resolvedPath))) {
      throw new Error(`[ScriptAssemblyStep] Script '${resolvedPath}' does not exist`);
    }

    const fileName = path.basename(resolvedPath);
    await fs.copy(resolvedPath, path.join(targetDir, fileName));
    this.logger?.debug(`Copied script '${scriptPath}' to ${targetDir}`);
  }
}

/**
 * Normalise script config values into a flat string array of paths.
 * Accepts: `string`, `string[]`, `Array<{ path: string }>`, or mixed.
 */
function normalizeScriptPaths(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) {
    const paths: string[] = [];
    for (const entry of value) {
      const resolved = typeof entry === 'string' ? entry : (entry as {path?: string}).path;
      if (resolved) paths.push(resolved);
    }

    return paths;
  }

  return [];
}
