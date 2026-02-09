import EventEmitter from 'node:events';

import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage from '../sfpm-package.js';

/**
 * Interface for specific package installer implementations (Strategy Pattern)
 * Installers can emit events by extending EventEmitter
 */
export interface Installer {
  connect(username: string): Promise<void>;
  exec(): Promise<any>;
}

/**
 * Constructor signature for package installers
 */
export type InstallerConstructor = new (
  targetOrg: string,
  sfpmPackage: SfpmPackage,
  logger?: Logger
) => Installer;

/**
 * Registry to store and retrieve package installers by type
 */
export class InstallerRegistry {
  private static installers = new Map<Omit<PackageType, 'data' | 'diff'>, InstallerConstructor>();

  /**
   * Retrieves an installer for a specific package type
   */
  public static getInstaller(type: Omit<PackageType, 'data' | 'diff'>): InstallerConstructor | undefined {
    return InstallerRegistry.installers.get(type);
  }

  /**
   * Registers an installer for a specific package type
   */
  public static register(type: Omit<PackageType, 'data' | 'diff'>, installer: InstallerConstructor) {
    InstallerRegistry.installers.set(type, installer);
  }
}

/**
 * Decorator to register a package installer implementation
 */
export function RegisterInstaller(type: Omit<PackageType, 'data' | 'diff'>) {
  return (constructor: InstallerConstructor) => {
    InstallerRegistry.register(type, constructor);
  };
}
