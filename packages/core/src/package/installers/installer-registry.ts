import type {Org} from '@salesforce/core';

import type SfpmPackage from '../sfpm-package.js';

import {InstallEventSink, InstallOptions} from '../../index.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import {ManagedPackageRef} from './types.js';

/**
 * Result returned by an installer after execution.
 * Captures deployment metadata that callers (e.g., history tracking) may use.
 */
export interface InstallerResult {
  /** Salesforce deploy ID (source deploys) or PackageInstallRequest ID (version installs) */
  installId?: string;
}

/**
 * Result of an installation check.
 *
 * Returned by {@link Installer.isInstalled}. The method is infallible —
 * errors during the check resolve to `{ needsInstall: true, installReason: 'check-failed' }`
 * so callers never need a try/catch.
 */
export interface InstallCheckResult {
  installReason: 'check-failed' | 'hash-match' | 'not-installed' | 'version-installed';
  needsInstall: boolean;
}

/**
 * Interface for specific package installer implementations (Strategy Pattern)
 * Installers can emit events by extending EventEmitter
 */
export interface Installer {
  connect(targetOrg: Org): Promise<void>;
  /**
   * Check whether the package is already installed in the target org.
   *
   * Uses the appropriate service internally:
   * - Source/unlocked packages check {@link ArtifactService} for hash match
   * - Unlocked packages fall back to {@link PackageService} for 04t version check
   * - Managed packages check {@link PackageService} for subscriber version
   *
   * Must be called after {@link connect}. Guaranteed to never throw —
   * check failures resolve to `{ needsInstall: true }`.
   */
  isInstalled(): Promise<InstallCheckResult>;
  run(): Promise<InstallerResult>;
}

/**
 * Constructor signature for package installers.
 *
 * The second argument is either an {@link SfpmPackage} subclass (for local
 * packages with source) or a {@link ManagedPackageRef} (for subscriber
 * packages that only carry a version ID). Each concrete installer narrows the
 * type and validates at runtime.
 */
export type InstallerConstructor = new (
  workingDirectory: string,
  installable: ManagedPackageRef | SfpmPackage,
  options?: InstallOptions,
  logger?: Logger,
  sink?: InstallEventSink,
) => Installer;

/**
 * Interface for installation-related auxiliary tasks inferred from package contents
 *
 * These are tasks that happen before or after the core installation operation,
 * such as:
 * - Activating flows
 * - Running pre-install scripts
 * - Running post-install scripts
 * - Assigning permission sets
 * - Data seeding
 * - Org configuration
 *
 * The core installation itself (source deploy or version install) is NOT a task,
 * but rather a core operation of the installation strategy.
 */
export interface InstallTask {
  canRun?(): boolean;
  /**
   * Execute the auxiliary task
   */
  exec(): Promise<void>;
  name: string;
}

/**
 * Context provided by the pipeline to every install task.
 * Tasks receive this via their factory function — never construct it themselves.
 */
export interface InstallTaskContext {
  readonly installId?: string;
  readonly logger?: Logger;
  readonly sfpmPackage: SfpmPackage;
  readonly sink?: InstallEventSink;
  readonly targetOrg: Org;
  readonly workingDirectory: string;
}

/**
 * A registration entry combining a task factory with its execution phase.
 * Builders expose a single `tasks` array of these entries.
 * The pipeline splits by phase and runs in insertion order within each phase.
 */
export interface InstallTaskRegistration {
  factory: (ctx: InstallTaskContext) => InstallTask;
  phase: 'post' | 'pre';
}

/**
 * Registry to store and retrieve package installers by type
 */
export class InstallerRegistry {
  private static installers = new Map<Omit<PackageType, 'diff'>, InstallerConstructor>();

  /**
   * Retrieves an installer for a specific package type
   */
  public static getInstaller(type: Omit<PackageType, 'diff'>): InstallerConstructor | undefined {
    return InstallerRegistry.installers.get(type);
  }

  /**
   * Registers an installer for a specific package type
   */
  public static register(type: Omit<PackageType, 'diff'>, installer: InstallerConstructor) {
    InstallerRegistry.installers.set(type, installer);
  }
}

/**
 * Decorator to register a package installer implementation.
 *
 * The decorator accepts any constructor that produces an {@link Installer};
 * it casts internally so concrete constructors (which narrow the installable
 * parameter) don't clash with the broader {@link InstallerConstructor} union.
 */
export function RegisterInstaller(type: Omit<PackageType, 'diff'>) {
  return (constructor: new (...args: any[]) => Installer) => {
    InstallerRegistry.register(type, constructor as InstallerConstructor);
  };
}

/**
 * Factory function to create an installer instance for a given package, based on its type.
 * The installer is selected from the {@link InstallerRegistry} using the package type.
 *
 * @param workingDirectory The working directory for the installer
 * @param sfpmPackage The package to be installed
 * @param options Installation options
 * @param logger The logger instance
 * @param sink Optional event sink for installation events
 * @param installAs Override the package type used for installer lookup.
 *   Allows the orchestrator to route an unlocked package through the source
 *   installer (e.g., for `sfpm deploy` where source is deployed directly).
 * @returns An instance of the appropriate installer
 */
export function installerFactory(
  workingDirectory: string,
  sfpmPackage: ManagedPackageRef | SfpmPackage,
  options?: InstallOptions,
  logger?: Logger,
  sink?: InstallEventSink,
  installAs?: PackageType,
): Installer {
  let packageType: PackageType;
  if (installAs) {
    packageType = installAs;
  } else if (sfpmPackage instanceof ManagedPackageRef) {
    packageType = PackageType.Managed;
  } else {
    packageType = (sfpmPackage as SfpmPackage).type as PackageType;
  }

  const InstallerConstructor = InstallerRegistry.getInstaller(packageType as any);
  if (!InstallerConstructor) {
    throw new Error(`No installer registered for package type: ${packageType}`);
  }

  return new InstallerConstructor(workingDirectory, sfpmPackage, options, logger, sink);
}

