import path from 'node:path'

/**
 * Workspace candidate for package selection.
 * Combines a package's identity with its keywords, which double as sfpm's
 * package tags (an arbitrary, user-assigned label — no reserved prefix,
 * no enforced vocabulary), for tag-based filtering.
 */
export interface WorkspaceCandidate {
  /** Absolute path to the package directory */
  dir: string
  /** Keywords from package.json — the storage field backing sfpm's package tags */
  keywords: string[]
  /** Package name (scoped or unscoped) */
  name: string
}

/**
 * A selection mode: which strategy to use for picking packages.
 */
export type SelectionMode = {dir: string; kind: 'path'} | {kind: 'all'} | {kind: 'explicit'; names: string[]} | {kind: 'tag'; tags: string[]}

/**
 * Determine the package selection mode from supplied flags.
 *
 * Ensures exactly one selection strategy is active; throws if multiple are specified.
 *
 * @param names - Explicitly named packages from argv
 * @param tags - Package tags specified via --tag (matched against package.json keywords)
 * @param dir - Directory path specified via --path
 * @returns SelectionMode configured for the active strategy
 * @throws Error if more than one selection mode is active
 */
export function resolveSelectionMode(names: string[], tags?: string[], dir?: string): SelectionMode {
  // Identify which modes are active
  const active: string[] = []
  if (names.length > 0) active.push('packages')
  if (tags?.length) active.push('--tag')
  if (dir) active.push('--path')

  if (active.length > 1) {
    throw new Error(`Select packages by exactly one of: package names, --tag, or --path (got ${active.join(', ')}).`)
  }

  if (names.length > 0) return {kind: 'explicit', names}
  if (tags?.length) return {kind: 'tag', tags}
  if (dir) return {dir, kind: 'path'}
  return {kind: 'all'}
}

/**
 * Check if a child directory is within a parent directory.
 *
 * Both paths are resolved to absolute form.
 * Returns true if child is exactly parent or a descendant of parent (not a sibling).
 *
 * @param parent - Parent directory path
 * @param child - Child directory path
 * @returns true if child is parent or within parent
 */
function isWithin(parent: string, child: string): boolean {
  const absParent = path.resolve(parent)
  const absChild = path.resolve(child)

  // Exact match
  if (absParent === absChild) return true

  const rel = path.relative(absParent, absChild)
  // rel starts with '..' => child is outside parent
  // isAbsolute(rel) => child is on a different drive (windows)
  // otherwise, rel is a relative path from parent to child
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

/**
 * Decide whether `release create` was invoked with no selection or naming
 * signal at all — i.e. bare `sfpm release create`, which should launch the
 * interactive guided walkthrough instead of failing on a missing --name.
 *
 * @param argv - Positional package name arguments
 * @param flags - The subset of flags that count as a selection/naming signal
 * @param flags.name - The --name flag value, if supplied
 * @param flags.path - The --path flag value, if supplied
 * @param flags.tag - The --tag flag value(s), if supplied
 * @returns true when nothing was supplied and the wizard should run
 */
export function isBareInvocation(argv: string[], flags: {name?: string; path?: string; tag?: string[]}): boolean {
  return argv.length === 0 && !flags.tag?.length && !flags.path && !flags.name
}

/**
 * Collect the distinct package tags (package.json keywords) present across
 * a set of workspace candidates, sorted for stable prompt/display order.
 *
 * @param candidates - Available workspace packages with metadata
 * @returns Sorted array of distinct tag values
 */
export function getDistinctTags(candidates: WorkspaceCandidate[]): string[] {
  const tags = new Set<string>()
  for (const candidate of candidates) {
    for (const keyword of candidate.keywords) {
      tags.add(keyword)
    }
  }

  return [...tags].sort()
}

/**
 * Select package names from candidates using the specified selection mode.
 *
 * @param candidates - Available workspace packages with metadata
 * @param mode - The selection strategy to apply
 * @returns Array of selected package names
 */
export function selectPackageNames(candidates: WorkspaceCandidate[], mode: SelectionMode): string[] {
  switch (mode.kind) {
  case 'all': {
    return candidates.map(c => c.name)
  }

  case 'explicit': {
    return mode.names
  }

  case 'path': {
    return candidates.filter(c => isWithin(mode.dir, c.dir)).map(c => c.name)
  }

  case 'tag': {
    return candidates
    .filter(c => mode.tags.some(t => c.keywords.includes(t)))
    .map(c => c.name)
  }
  }
}

/**
 * Version mismatch detail in reconciliation.
 */
export interface ReconcileMismatch {
  actual: string
  expected: string
  name: string
}

/**
 * Result of manifest reconciliation.
 */
export interface ReconcileResult {
  mismatched: ReconcileMismatch[]
  missing: string[]
}

/**
 * Reconcile a release manifest against what's currently in node_modules.
 *
 * Checks for:
 * - Missing packages (declared but not installed)
 * - Version mismatches (unless --skip-version-check is set)
 *
 * Uses exact string comparison, not semver.eq — a release pins an exact artifact.
 *
 * @param declared - Packages and versions from the release manifest
 * @param resolved - Packages and versions currently in node_modules (from ArtifactProvider)
 * @param options - Control behavior
 * @param options.skipVersionCheck - Skip version mismatch checks (still validates packages are present)
 * @returns Reconciliation result with missing and mismatched arrays
 */
export function reconcileManifest(
  declared: {name: string; version: string}[],
  resolved: Map<string, string>,
  options?: {skipVersionCheck?: boolean},
): ReconcileResult {
  const mismatched: ReconcileMismatch[] = []
  const missing: string[] = []

  for (const {name, version} of declared) {
    const actual = resolved.get(name)

    if (actual === undefined) {
      missing.push(name)
      continue
    }

    // Only check version mismatch if not explicitly skipped
    if (!options?.skipVersionCheck && actual !== version) {
      mismatched.push({actual, expected: version, name})
    }
  }

  return {mismatched, missing}
}
