import {type PackageCreateConfig} from '@b64/sfpm-core'

/**
 * Bootstrap tiers determine which packages are installed into the target org.
 *
 * - `Core`  — sfpm-artifact only (custom setting for artifact tracking)
 * - `Pool`  — Core + sfpm-orgs (scratch org & sandbox pooling, org-dependent)
 * - `Full`  — Pool + sfpm-ui (artifact history object + UI components)
 */
export enum BootstrapTier {
  Core = 'core',
  Full = 'full',
  Pool = 'pool',
}

/** Static definition of the three SFPM bootstrap packages and their relationships. */
export interface BootstrapPackageConfig extends PackageCreateConfig {
  /** Package names this package depends on (within the bootstrap set). */
  dependencies: string[];
}

/** Per-package action determined by the idempotent status check. */
export type BootstrapAction = 'build' | 'install' | 'promote' | 'skip'

/** Per-package outcome within a bootstrap run. */
export interface BootstrapPackageResult {
  action: BootstrapAction;
  error?: string;
  packageName: string;
  promoted?: boolean;
  skipped: boolean;
  success: boolean;
  version?: string;
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

/** The canonical package configs for the bootstrap repo. */
export const BOOTSTRAP_PACKAGES: BootstrapPackageConfig[] = [
  {
    dependencies: [],
    description: 'Core custom setting for artifact tracking (SfpmArtifact__c)',
    isOrgDependent: false,
    name: '@b64/sfpm-artifact',
    path: 'packages/sfpm-artifact',
  },
  {
    dependencies: ['@b64/sfpm-artifact'],
    description: 'Scratch org & sandbox pool management (org-dependent)',
    isOrgDependent: true,
    name: '@b64/sfpm-orgs',
    path: 'packages/sfpm-orgs',
  },
  {
    dependencies: ['@b64/sfpm-artifact'],
    description: 'Artifact history object & UI components',
    isOrgDependent: false,
    name: '@b64/sfpm-ui',
    path: 'packages/sfpm-ui',
  },
]

/** Resolve which packages to include for a given tier. */
export function getPackagesForTier(tier: BootstrapTier): BootstrapPackageConfig[] {
  switch (tier) {
  case BootstrapTier.Core: {
    return BOOTSTRAP_PACKAGES.filter(p => p.name === '@b64/sfpm-artifact')
  }

  case BootstrapTier.Full: {
    return [...BOOTSTRAP_PACKAGES]
  }

  case BootstrapTier.Pool: {
    return BOOTSTRAP_PACKAGES.filter(p => p.name !== '@b64/sfpm-ui')
  }
  }
}
