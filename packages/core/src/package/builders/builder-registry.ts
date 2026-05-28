import EventEmitter from 'node:events';

import {IgnoreFilesConfig} from '../../types/config.js';
import {DependencyAnalyzer} from '../../types/dependency-analysis.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js';
import SfpmPackage from '../sfpm-package.js';

// ============================================================================
// Build Task Contract
// ============================================================================

/**
 * Context provided by the pipeline to every build task.
 * Tasks receive this via their factory function — never construct it themselves.
 */
export interface BuildTaskContext {
  readonly eventEmitter?: EventEmitter;
  readonly logger?: Logger;
  readonly projectDirectory: string;
  readonly sfpmPackage: SfpmPackage;
}

/**
 * Package enrichments that a task wants applied after execution.
 * The pipeline is the single writer — tasks return these values
 * instead of mutating sfpmPackage directly.
 */
export interface BuildTaskEnrichments {
  sourceHash?: string;
  sourceTag?: string;
  testCoverage?: number;
}

/**
 * Structured result from task execution.
 *
 * - `enrichments` — data the pipeline should apply to the package
 * - `skip` — signals the pipeline to halt the entire build for this package
 */
export interface BuildTaskResult {
  enrichments?: BuildTaskEnrichments;
  skip?: {
    artifactPath?: string;
    latestVersion?: string;
    reason: string;
  };
}

/**
 * A discrete unit of work that runs before or after the core build step.
 *
 * Tasks follow these conventions:
 * - `name` — stable, human-readable identifier (e.g., 'source-hash', 'validation')
 * - `canRun()` — optional runtime precondition check (e.g., "package has Apex").
 *   Return false to skip the task. Config-driven skips (e.g., skipValidation)
 *   should be handled at registration time by not adding the factory.
 * - `exec()` — perform the work. Return enrichments/skip or void.
 *   Do not mutate sfpmPackage; return enrichments instead.
 *
 * Events:
 * - Pipeline emits `task:start`, `task:complete`, `task:skipped` for every task.
 * - Tasks may emit domain events via `context.eventEmitter` using the
 *   namespace `task:{name}:{lifecycle}` (e.g., `task:validation:progress`).
 */
export interface BuildTask {
  canRun?(): boolean;
  exec(): Promise<BuildTaskResult | void>;
  readonly name: string;
}

/**
 * A registration entry combining a task factory with its execution phase.
 * Builders expose a single `tasks` array of these entries.
 * The pipeline splits by phase and runs in insertion order within each phase.
 */
export interface BuildTaskRegistration {
  factory: (ctx: BuildTaskContext) => BuildTask;
  phase: 'post' | 'pre';
}

// ============================================================================
// Builder Contract
// ============================================================================

/**
 * Interface for specific package builder implementations (Strategy Pattern).
 * Builders can emit events by extending EventEmitter.
 */
export interface Builder {
  connect(username: string): Promise<void>;
  exec(): Promise<any>;
  tasks: BuildTaskRegistration[];
}

/**
 * Options passed to package builders.
 * Contains configuration from sfpm.config.ts that builders may need.
 */
export interface BuilderOptions {
  /** Target org for source package validation (deploy + test) */
  buildOrg?: string;
  /** Optional dependency analyzer for static dependency validation */
  dependencyAnalyzer?: DependencyAnalyzer;
  /** Ignore files configuration for assembly */
  ignoreFilesConfig?: IgnoreFilesConfig;
  /** Skip the deploy+test validation step */
  skipValidation?: boolean;
  /** Log dependency violations as warnings instead of throwing */
  warnOnMissingDependencies?: boolean;
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
