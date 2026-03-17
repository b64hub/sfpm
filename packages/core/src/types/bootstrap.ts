/**
 * Bootstrap tiers determine which packages are installed into the target org.
 *
 * - `Core`  — sfpm-artifact only (custom setting for artifact tracking)
 * - `Pool`  — Core + sfpm-orgs (scratch org & sandbox pooling, org-dependent)
 * - `Full`  — Pool + sfpm (artifact history object + UI components)
 */
export enum BootstrapTier {
  Core = 'core',
  Full = 'full',
  Pool = 'pool',
}

/** Static definition of the three SFPM bootstrap packages and their relationships. */
export interface BootstrapPackageConfig {
  /** Package names this package depends on (within the bootstrap set). */
  dependencies: string[];
  /** Human-readable description shown during interactive selection. */
  description: string;
  /** Whether this is an org-dependent unlocked package. */
  isOrgDependent: boolean;
  /** Package name as it appears in sfdx-project.json. */
  name: string;
  /** Relative path inside the bootstrap repo. */
  path: string;
}

/** Result of attempting to create or resolve a single Package2 container in the DevHub. */
export interface PackageCreationResult {
  /** Whether the package was freshly created (false = already existed). */
  created: boolean;
  /** The Package2 name. */
  name: string;
  /** The Package2 Id (0Ho prefix). */
  packageId: string;
}

/** Overall result of the bootstrap operation. */
export interface BootstrapResult {
  /** Per-package build+install outcomes. */
  packages: BootstrapPackageResult[];
  /** Whether all packages were successfully bootstrapped. */
  success: boolean;
  /** The target org alias/username. */
  targetOrg: string;
  /** Selected tier. */
  tier: BootstrapTier;
}

/** Per-package outcome within a bootstrap run. */
export interface BootstrapPackageResult {
  error?: string;
  packageName: string;
  skipped: boolean;
  success: boolean;
}

/** The canonical package configs for the bootstrap repo. */
export const BOOTSTRAP_PACKAGES: BootstrapPackageConfig[] = [
  {
    dependencies: [],
    description: 'Core custom setting for artifact tracking (SfpmArtifact__c)',
    isOrgDependent: false,
    name: 'sfpm-artifact',
    path: 'sfpm-artifact',
  },
  {
    dependencies: ['sfpm-artifact'],
    description: 'Scratch org & sandbox pool management (org-dependent)',
    isOrgDependent: true,
    name: 'sfpm-orgs',
    path: 'sfpm-orgs',
  },
  {
    dependencies: ['sfpm-artifact'],
    description: 'Artifact history object & UI components',
    isOrgDependent: false,
    name: 'sfpm',
    path: 'sfpm',
  },
];

/** Resolve which packages to include for a given tier. */
export function getPackagesForTier(tier: BootstrapTier): BootstrapPackageConfig[] {
  switch (tier) {
  case BootstrapTier.Core: {
    return BOOTSTRAP_PACKAGES.filter(p => p.name === 'sfpm-artifact');
  }

  case BootstrapTier.Full: {
    return [...BOOTSTRAP_PACKAGES];
  }

  case BootstrapTier.Pool: {
    return BOOTSTRAP_PACKAGES.filter(p => p.name !== 'sfpm');
  }
  }
}
