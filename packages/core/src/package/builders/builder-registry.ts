import EventEmitter from 'node:events';

import {IgnoreFilesConfig, SfpmConfig} from '../../types/config.js';
import {SourceBuildEvents, UnlockedBuildEvents} from '../../types/events.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage from '../sfpm-package.js';

export interface BuildTask {
  exec(): Promise<void>;
}

/**
 * Interface for specific package builder implementations (Strategy Pattern)
 * Builders can emit events by extending EventEmitter
 */
export interface Builder {
  connect(username: string): Promise<void>;
  exec(): Promise<any>;
  /** Tasks to run after the core build logic */
  postBuildTasks?: BuildTask[];
  /** Tasks to run before the core build logic */
  preBuildTasks?: BuildTask[];
}

/**
 * Options passed to package builders.
 * Contains configuration from sfpm.config.ts that builders may need.
 */
export interface BuilderOptions {
  /** Ignore files configuration for assembly */
  ignoreFilesConfig?: IgnoreFilesConfig;
}

/**
 * Constructor signature for package builders
 */
export type BuilderConstructor = new (
  workingDirectory: string,
  sfpmPackage: SfpmPackage,
  options: BuilderOptions,
  logger?: Logger
) => Builder;

/**
 * Registry to store and retrieve package builders by type
 */
export class BuilderRegistry {
  private static builders = new Map<Omit<PackageType, 'managed'>, BuilderConstructor>();

  /**
   * Retrieves a builder for a specific package type
   */
  public static getBuilder(type: Omit<PackageType, 'managed'>): BuilderConstructor | undefined {
    return BuilderRegistry.builders.get(type);
  }

  /**
   * Registers a builder for a specific package type
   */
  public static register(type: Omit<PackageType, 'managed'>, builder: BuilderConstructor) {
    BuilderRegistry.builders.set(type, builder);
  }
}

/**
 * Decorator to register a package builder implementation
 */
export function RegisterBuilder(type: Omit<PackageType, 'managed'>) {
  return (constructor: BuilderConstructor) => {
    BuilderRegistry.register(type, constructor);
  };
}
