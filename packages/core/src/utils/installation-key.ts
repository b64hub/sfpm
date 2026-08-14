/**
 * Per-package installation key overrides, keyed by unscoped package name.
 * The special `'*'` key is a fallback applied to any package without an
 * explicit override (and is what a single bare key resolves to).
 */

/**
 * Parse `<package-name>=<key>` entries (as passed via CLI or a GitHub Actions
 * multi-line input) into a package-name -> installation-key map. An entry
 * with no `=` is treated as the default key for every package (`'*'`).
 */
export function parseInstallationKeys(entries: string[]): Record<string, string> {
  const keys: Record<string, string> = {};
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    if (eq === -1) keys['*'] = entry;
    else keys[entry.slice(0, eq)] = entry.slice(eq + 1);
  }

  return keys;
}

/** Resolve the installation key for a package, falling back to the `'*'` default. */
export function resolveInstallationKey(keys: Record<string, string> | undefined, packageName: string): string | undefined {
  return keys?.[packageName] ?? keys?.['*'];
}
