import type SfpmPackage from '../sfpm-package.js';
import type {ManagedPackageRef} from './types.js';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';

/**
 * Result returned by an installer after execution.
 * Captures deployment metadata that callers (e.g., history tracking) may use.
 */
export interface InstallerExecResult {
  /** Salesforce deploy ID (source deploys) or PackageInstallRequest ID (version installs) */
  deployId?: string;
}

/**
 * Interface for specific package installer implementations (Strategy Pattern)
 * Installers can emit events by extending EventEmitter
 */
export interface Installer {
  connect(username: string): Promise<void>;
  exec(): Promise<InstallerExecResult>;
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
  targetOrg: string,
  installable: ManagedPackageRef | SfpmPackage,
  logger?: Logger,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- rest params must accept any shape for concrete installer variance
  ...rest: any[]
) => Installer;

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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- decorator must accept any constructor shape
  return (constructor: new (...args: any[]) => Installer) => {
    InstallerRegistry.register(type, constructor as InstallerConstructor);
  };
}
