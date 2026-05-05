/**
 * Utilities for working with npm package name scopes.
 *
 * @example
 * ```typescript
 * stripScope('@myorg/core-package'); // → 'core-package'
 * extractScope('@myorg/core-package'); // → '@myorg'
 * ```
 */

/**
 * Strip the npm scope from a package name.
 * "@myorg/core-package" → "core-package"
 * "core-package" → "core-package"
 */
export function stripScope(name: string): string {
  const match = name.match(/^@[^/]+\/(.+)$/);
  return match ? match[1] : name;
}

/**
 * Extract the npm scope from a scoped package name.
 * "@myorg/core-package" → "@myorg"
 * "core-package" → undefined
 */
export function extractScope(name: string): string | undefined {
  const match = name.match(/^(@[^/]+)\//);
  return match ? match[1] : undefined;
}
