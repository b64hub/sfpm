import yaml from 'js-yaml';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {dirname} from 'node:path';
import {z} from 'zod';

/**
 * A single package entry in a release definition.
 */
export interface ReleasePackage {
  /** Package name (scoped or unscoped) */
  name: string;
  /** Exact semver version to install */
  version: string;
}

/**
 * Options controlling release installation behavior.
 * Mirrors InstallOrchestrator options.
 *
 * `unlocked.sourceOnly` is deliberately not modeled here: `release run`
 * always installs from built artifacts (`InstallOrchestrator.forArtifact`),
 * never from source, so a source-only routing flag has no valid meaning
 * in a release manifest.
 */
export interface ReleaseOptions {
  force?: boolean;
  includeDependencies?: boolean;
  regressionTest?: boolean;
  testLevel?: string;
  unlocked?: {
    [key: string]: unknown;
    installationKeys?: Record<string, string>;
  };
}

/**
 * Release definition loaded from a YAML manifest.
 * Specifies a set of packages and versions to install, plus optional configuration.
 *
 * The `ref` field is provenance only — it records which git ref was used to
 * resolve package tags during creation. It is never consumed by `release run`.
 */
export interface ReleaseDefinition {
  /** Installation options (merged with orchestrator defaults) */
  options?: ReleaseOptions;
  /** Packages and versions to install */
  packages: ReleasePackage[];
  /** Git ref (branch, tag, or commit) used to resolve package versions (provenance only) */
  ref?: string;
  /** Release name (used to derive default manifest filename) */
  release: string;
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const ReleasePackageSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const ReleaseDefinitionSchema = z.object({
  options: z.object({
    force: z.boolean().optional(),
    includeDependencies: z.boolean().optional(),
    regressionTest: z.boolean().optional(),
    testLevel: z.string().optional(),
    unlocked: z.object({
      installationKeys: z.record(z.string(), z.string()).optional(),
    }).passthrough().optional(),
  }).passthrough().optional(),
  packages: z.array(ReleasePackageSchema),
  ref: z.string().optional(),
  release: z.string(),
}).passthrough();

// ============================================================================
// Constants and utilities
// ============================================================================

/** Default directory for release manifests */
export const RELEASE_DIR = 'release';

/**
 * Read and parse a release definition from a YAML file.
 * Validates against ReleaseDefinitionSchema and provides a descriptive error on validation failure.
 *
 * @param filePath - Absolute or relative path to the release YAML file
 * @returns Parsed and validated ReleaseDefinition
 * @throws Error if file is not found, not valid YAML, or fails schema validation
 */
export function readReleaseDefinition(filePath: string): ReleaseDefinition {
  const content = readFileSync(filePath, 'utf8');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const parsed: any = yaml.load(content);

  const result = ReleaseDefinitionSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid release definition ${filePath}: ${issues}`);
  }

  return result.data;
}

/**
 * Write a release definition to a YAML file.
 * Creates parent directories as needed.
 *
 * @param filePath - Absolute or relative path where the release YAML should be written
 * @param def - ReleaseDefinition to serialize
 */
export function writeReleaseDefinition(filePath: string, def: ReleaseDefinition): void {
  mkdirSync(dirname(filePath), {recursive: true});
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const yamlStr: string = (yaml as any).dump(def, {noRefs: true, sortKeys: false});
  writeFileSync(filePath, yamlStr, 'utf8');
}
