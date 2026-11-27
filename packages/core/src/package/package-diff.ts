import type {PackageDefinition} from '../types/project.js';

import {InstalledArtifact, PackageType} from '../types/package.js';
import {stripScope} from '../utils/scope-utils.js';

/**
 * How a package compares between the project definition and the target org.
 *
 * - `match` — installed in the org at the same major.minor.patch version
 * - `version-mismatch` — installed in the org at a different version
 * - `not-installed` — defined in the project but absent from the org
 * - `not-in-project` — installed in the org but not defined in the project
 */
export type PackageDiffStatus = 'match' | 'not-in-project' | 'not-installed' | 'version-mismatch';

/**
 * One row of a project-vs-org package comparison.
 */
export interface PackageDiffEntry {
  /** Package name, without npm scope. */
  name: string;
  /** Version installed in the org, if any. */
  orgVersion?: string;
  /** Version defined in the project, if any. */
  projectVersion?: string;
  /** Comparison outcome. */
  status: PackageDiffStatus;
}

/**
 * Compare project package definitions against packages installed in an org.
 *
 * Packages are matched by scope-stripped name. Data packages are excluded
 * entirely (never shown, even as `not-in-project`) regardless of whether
 * sfpm happens to track an installed artifact for them. When the org reports
 * the same name more than once, only the first entry is used.
 *
 * @param projectPackages - Package definitions from the project
 * @param installed - Artifacts reported as installed in the org
 * @returns Entries sorted by name
 */
export function diffPackages(projectPackages: PackageDefinition[], installed: InstalledArtifact[]): PackageDiffEntry[] {
  const orgByName = new Map<string, InstalledArtifact>();
  for (const artifact of installed) {
    const key = stripScope(artifact.name);
    if (!orgByName.has(key)) {
      orgByName.set(key, artifact);
    }
  }

  const entries: PackageDiffEntry[] = [];
  const projectNames = new Set<string>();

  for (const pkg of projectPackages) {
    const name = stripScope(pkg.name);
    // Data packages are excluded from the diff entirely (not even as 'not-in-project'),
    // so their name must still be recorded here even though no entry is generated for them.
    projectNames.add(name);
    if (pkg.type === PackageType.Data) continue;

    const orgArtifact = orgByName.get(name);

    if (orgArtifact) {
      const same = normalizeVersion(pkg.version) === normalizeVersion(orgArtifact.version);
      entries.push({
        name,
        orgVersion: orgArtifact.version,
        projectVersion: pkg.version,
        status: same ? 'match' : 'version-mismatch',
      });
    } else {
      entries.push({name, projectVersion: pkg.version, status: 'not-installed'});
    }
  }

  for (const [name, artifact] of orgByName) {
    if (!projectNames.has(name)) {
      entries.push({name, orgVersion: artifact.version, status: 'not-in-project'});
    }
  }

  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

const SEMVER_PREFIX = /^(\d+\.\d+\.\d+)/;

// shortcut: compares major.minor.patch only (project semver vs org's 4-part build number), upgrade to a build-number-aware compare if that precision is ever needed
function normalizeVersion(version: string): string {
  const match = version.match(SEMVER_PREFIX);
  return match ? match[1] : version;
}
