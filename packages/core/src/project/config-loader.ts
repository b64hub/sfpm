import {createJiti} from 'jiti'
import {existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';

import {SfpmConfig} from '../types/config.js';
import Logger from '../types/logger.js';

export interface LoadSfpmConfigOptions {
  /**
   * Extra module aliases for jiti, as `package name -> absolute entry path`.
   *
   * Merged over the built-in default aliases for `@b64hub/sfpm-*` packages
   * (resolved from this module's own installation) — explicit entries here
   * win over the defaults. Only needed for packages not covered by the
   * default set, or to override where a default resolves from.
   */
  alias?: Record<string, string>;
}

/**
 * Config file names searched in priority order.
 * TypeScript files are preferred for type-safe authoring.
 */
const CONFIG_FILES = [
  'sfpm.config.ts',
  'sfpm.config.js',
  'sfpm.config.mjs',
] as const;

/**
 * Loads the SFPM configuration from a `sfpm.config.{ts,js,mjs}` file
 * in the project root directory.
 *
 * Uses `jiti` for transparent TypeScript loading — no build step required
 * for the config file. This is the same approach used by Nuxt, ESLint,
 * Tailwind, and other major tools.
 *
 * If no config file is found, returns a default empty configuration.
 * This ensures backwards compatibility — projects that haven't adopted
 * `sfpm.config.ts` continue to work without changes.
 *
 * @param projectRoot - Absolute path to the project root directory
 * @param logger - Optional logger for debug output
 * @returns The resolved SFPM configuration
 *
 * @example
 * ```typescript
 * const config = await loadSfpmConfig('/path/to/project');
 * const lifecycle = LifecycleEngine.stage();
 * config.plugins?.forEach(p => lifecycle.use(p));
 * ```
 */
export async function loadSfpmConfig(
  projectRoot: string,
  logger?: Logger,
  options?: LoadSfpmConfigOptions,
): Promise<SfpmConfig> {
  const configPath = resolveConfigPath(projectRoot);

  if (!configPath) {
    logger?.debug('No sfpm.config.{ts,js,mjs} found, using default configuration');
    return {};
  }

  logger?.debug(`Loading SFPM config from: ${configPath}`);

  try {
    // configPath is the resolution base, so imports in the config file resolve
    // from the target project's node_modules. Projects without these packages
    // installed fall back to resolving them from the CLI's own installation
    // (see defaultConfigAlias). Callers may override via options.alias.
    const alias = {...defaultConfigAlias(), ...options?.alias};
    const jiti = createJiti(configPath, {
      alias,
      fsCache: true,
      interopDefault: true,
    });

    const loaded = await jiti.import(configPath);

    // Handle default export (ESM) or module.exports (CJS)
    const configOrFactory = (loaded && typeof loaded === 'object' && 'default' in loaded)
      ? (loaded as {default: unknown}).default
      : loaded;

    // Support factory functions: export default defineConfig(() => ({ ... }))
    const config = typeof configOrFactory === 'function'
      ? await (configOrFactory as () => Promise<SfpmConfig> | SfpmConfig)()
      : configOrFactory as SfpmConfig;

    if (!config || typeof config !== 'object') {
      throw new Error(`Config file '${configPath}' must export an object (use defineConfig() for type safety).`);
    }

    logger?.debug(`Loaded SFPM config with ${config.hooks?.length ?? 0} hook set(s)`);
    return config;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Failed to load SFPM config from '${configPath}': ${message}`,
      {cause: error},
    );
  }
}

/**
 * Default jiti aliases for sfpm packages, resolved from this module's own
 * installation. Lets a project's `sfpm.config.ts` import `@b64hub/sfpm-*`
 * even when those packages aren't installed in the project itself. Packages
 * not installed alongside this module are silently omitted.
 */
function defaultConfigAlias(): Record<string, string> {
  const require = createRequire(import.meta.url);
  const alias: Record<string, string> = {};

  for (const name of ['@b64hub/sfpm-core', '@b64hub/sfpm-orgs', '@b64hub/sfpm-hooks', '@b64hub/sfpm-sfdmu']) {
    try {
      alias[name] = require.resolve(name);
    } catch {
      // Not installed alongside this module — a config importing it will fail
      // with jiti's own resolution error, which names the missing package.
    }
  }

  return alias;
}

/**
 * Resolve the config file path by searching for known filenames in priority order.
 * Returns undefined if no config file is found.
 */
export function resolveConfigPath(projectRoot: string): string | undefined {
  for (const filename of CONFIG_FILES) {
    const fullPath = resolve(projectRoot, filename);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  return undefined;
}
