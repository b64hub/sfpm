import semver from 'semver';

import Git from '../git/git.js';

/**
 * Pattern to match package version tags in the format `<name>@<version>`.
 * Not to be confused with sfpm's package tags (arbitrary labels stored in
 * package.json `keywords`, see cli/src/types/release.ts) — this is strictly
 * the git tagging convention used to track released package versions.
 *
 * Uses a greedy `.+` to match the package name, which is load-bearing:
 * it splits on the *last* `@` in strings like `@scope/pkg@1.2.3`.
 * Do not make this lazy (`.+?`).
 */
const PACKAGE_VERSION_TAG_PATTERN = /^(?<name>.+)@(?<version>[^@]+)$/;

/**
 * Parse a list of git tags and extract the highest semver version for each package.
 *
 * - Splits each tag on the last `@` to extract package name and version.
 * - Discards non-semver values (e.g. plain refs used as `--ref`, like `latest` or `summer-release-candidate`)—
 *   these are not package version tags.
 * - Returns only one version per package: the highest by semver precedence.
 * - Silently skips malformed or non-package-version-tag lines without throwing.
 *
 * @param tagLines - Array of git tag names (typically from `git tag --merged <ref>`)
 * @returns Map of package name -> highest semver version
 */
export function resolveLatestPackageVersionTags(tagLines: string[]): Map<string, string> {
  const latest = new Map<string, string>();

  for (const line of tagLines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const match = PACKAGE_VERSION_TAG_PATTERN.exec(trimmed);
    if (!match?.groups) continue;

    const {name, version} = match.groups;

    // Skip non-semver versions (e.g. plain refs used as --ref, junk)
    if (!semver.valid(version)) continue;

    const current = latest.get(name);
    // Keep the higher version by semver precedence
    if (!current || semver.gt(version, current)) {
      latest.set(name, version);
    }
  }

  return latest;
}

/**
 * Read package version tags merged into a git ref and resolve to latest versions per package.
 *
 * Uses `git tag --merged <ref>` to find all tags reachable from the given ref,
 * then parses them to extract package versions.
 *
 * @param git - Git instance connected to the repository
 * @param ref - Any git ref: a branch name, a plain tag used as a history marker, or a commit hash
 * @returns Map of package name -> highest semver version reachable from `ref`
 * @throws Error if the git command fails or the ref doesn't exist
 */
export async function readLatestPackageVersionTags(git: Git, ref: string): Promise<Map<string, string>> {
  try {
    const tagLines = await git.tag(['--merged', ref]);
    return resolveLatestPackageVersionTags(tagLines);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error([
      `Failed to read git tags merged into "${ref}". Ensure the ref exists locally`,
      '(a shallow CI clone may need `git fetch --tags --unshallow`).',
      `Cause: ${message}`,
    ].join(' '));
  }
}
