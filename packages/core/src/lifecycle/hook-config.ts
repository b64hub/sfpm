import type {HookContext} from '../types/lifecycle.js';
import type {PackageHookConfig} from '../types/project.js';

// ============================================================================
// Resolved Hook Config
// ============================================================================

/**
 * Normalised per-package hook configuration returned by {@link resolveHookConfig}.
 *
 * @typeParam T - The hook-specific config shape. Defaults to an empty record.
 */
export interface ResolvedHookConfig<T = Record<string, unknown>> {
  /**
   * The hook-specific configuration object. Empty when:
   * - No per-package override exists (hook uses global defaults)
   * - The override was a boolean shorthand (`true` / `false`)
   */
  config: T;
  /** Whether this hook is enabled for the current package. */
  enabled: boolean;
}

// ============================================================================
// Public resolution function
// ============================================================================

/**
 * Resolve per-package hook configuration from the hook context.
 *
 * Reads `context.sfpmPackage.packageDefinition.packageOptions.hooks[hookName]`
 * and normalises it into a consistent {@link ResolvedHookConfig}:
 *
 * | Value in `packageOptions.hooks` | `enabled` | `config`           |
 * |---------------------------------|-----------|--------------------|
 * | _not set_                       | `true`    | `{}`               |
 * | `true`                          | `true`    | `{}`               |
 * | `false`                         | `false`   | `{}`               |
 * | `{ enabled: false }`            | `false`   | `{}`               |
 * | `{ post: ["Admin"] }`           | `true`    | `{ post: ["Admin"] }` |
 *
 * @param context - The current hook context (must contain `sfpmPackage`)
 * @param hookName - The hook's registered name (matches `LifecycleHooks.name`)
 * @returns Normalised config with `enabled` flag and hook-specific overrides
 *
 * @example
 * ```typescript
 * // Inside a hook handler:
 * const { enabled, config } = resolveHookConfig<PermSetHookOverrides>(context, 'permission-set');
 * if (!enabled) return;
 * const postPermSets = config.post ?? globalDefaults.post;
 * ```
 */
export function resolveHookConfig<T = Record<string, unknown>>(
  context: HookContext,
  hookName: string,
): ResolvedHookConfig<T> {
  const raw = readRawHookConfig(context, hookName);

  // No per-package override → enabled with empty config
  if (raw === undefined) {
    return {config: {} as T, enabled: true};
  }

  // Boolean shorthand
  if (typeof raw === 'boolean') {
    return {config: {} as T, enabled: raw};
  }

  // Object form — extract `enabled`, rest is config
  const {enabled, ...rest} = raw;
  return {
    config: rest as T,
    enabled: enabled !== false,
  };
}

/**
 * Check if a hook is enabled for the current package.
 * Convenience wrapper around {@link resolveHookConfig} when you only
 * need the enabled/disabled check.
 */
export function isHookEnabled(context: HookContext, hookName: string): boolean {
  return resolveHookConfig(context, hookName).enabled;
}

// ============================================================================
// Internal helpers
// ============================================================================

/**
 * Shape we expect on `context.sfpmPackage` to read per-package hook config.
 */
interface PackageWithHookConfig {
  packageDefinition?: {
    packageOptions?: {
      hooks?: Record<string, boolean | PackageHookConfig>;
    };
  };
}

/**
 * Read the raw hook config value from the package definition.
 */
function readRawHookConfig(
  context: HookContext,
  hookName: string,
): boolean | PackageHookConfig | undefined {
  const sfpmPackage = context.sfpmPackage as PackageWithHookConfig | undefined;
  return sfpmPackage?.packageDefinition?.packageOptions?.hooks?.[hookName];
}
