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

export function splitPackageName(name: string): {name: string; scope?: string;} {
  const scope = extractScope(name);
  const unscopedName = stripScope(name);
  return {name: unscopedName, scope};
}

export function joinPackageName(name: string, scope?: string): string {
  return scope ? `${scope}/${name}` : name;
}

/**
 * Resolve a user-supplied package name against a list of known scoped names.
 *
 * - Already-scoped input that matches exactly → returns the match.
 * - Unscoped input with exactly one matching package → returns the scoped name.
 * - Zero matches → throws with "not found" message.
 * - Multiple matches → returns the array of candidates (caller decides: prompt or error).
 *
 * @param input - User-supplied package name (scoped or unscoped)
 * @param allNames - All known package names (expected to be scoped)
 * @returns The resolved scoped name, or an array of candidates if ambiguous
 */
export function resolvePackageName(input: string, allNames: string[]): string | string[] {
  // Exact match (scoped or unscoped that happens to be in the list)
  if (allNames.includes(input)) {
    return input;
  }

  // Unscoped lookup: find all packages where the unscoped part matches
  const candidates = allNames.filter(name => stripScope(name) === input);

  if (candidates.length === 1) {
    return candidates[0];
  }

  if (candidates.length === 0) {
    throw new Error(`Package "${input}" not found. Available packages:\n${allNames.map(n => `  - ${n}`).join('\n')}`);
  }

  // Ambiguous — return candidates for the caller to handle
  return candidates;
}
