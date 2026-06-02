import type {BuildEventSink} from '../../events/build-event-bus.js';

import {DependencyAnalyzer} from '../../types/dependency-analysis.js';
import {Logger} from '../../types/logger.js';
import {PackageType, PendingValidationDescriptor} from '../../types/package.js';
import SfpmPackage from '../sfpm-package.js';

// ============================================================================
// Build Task Contract
// ============================================================================

/**
 * Context provided by the pipeline to every build task.
 * Tasks receive this via their factory function — never construct it themselves.
 */
export interface BuildTaskContext {
  readonly logger?: Logger;
  readonly projectDirectory: string;
  readonly sfpmPackage: SfpmPackage;
  readonly sink?: BuildEventSink;
}

/**
 * Package enrichments that a task wants applied after execution.
 * The pipeline is the single writer — tasks return these values
 * instead of mutating sfpmPackage directly.
 */
export interface BuildTaskEnrichments {
  testCoverage?: number;
}

/**
 * Structured result from task execution.
 *
 * - `enrichments` — data the pipeline should apply to the package
 */
export interface BuildTaskResult {
  enrichments?: BuildTaskEnrichments;
}

/**
 * A discrete unit of work that runs before or after the core build step.
 *
 * Tasks follow these conventions:
 * - `name` — stable, human-readable identifier (e.g., 'validation', 'dependency-analysis')
 * - `canRun()` — optional runtime precondition check (e.g., "package has Apex").
 *   Return false to skip the task. Config-driven skips (e.g., validation disabled)
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
  /**
   * Optional validation step invoked after `exec()` completes but before post-build tasks.
   * Implementations initiate validation (deploy + test for source, polling for unlocked)
   * and set {@link ValidationState} on the domain model.
   *
   * Returns a {@link PendingValidationDescriptor} when validation was initiated asynchronously.
   * The caller (PackageBuilder) decides whether to await resolution or proceed with pending state.
   * Returns `undefined` when validation was skipped or not applicable.
   */
  validate?(): Promise<PendingValidationDescriptor | undefined>;
}

export interface DependencyAnalysis {
  dependencyAnalyzer?: DependencyAnalyzer;
  warnOnly?: boolean;
}

/**
 * Options passed to package builders.
 * Derived from {@link BuildOptions} and {@link ModeConfig} by the PackageBuilder.
 */
export interface BuilderOptions {
  /** Whether to produce a build artifact */
  artifact?: boolean;
  /** Target org for source package validation (deploy + test) */
  buildOrg?: string;
  dependencyAnalysis?: DependencyAnalysis;
  /** Installation key for unlocked packages */
  installationKey?: string;
  /** Validation mode for package builds */
  validation?: boolean;

  /** Timeout in minutes for package version creation */
  waitTime?: number;
}

/**
 * Constructor signature for package builders
 */
export type BuilderConstructor = new (
  workingDirectory: string,
  sfpmPackage: SfpmPackage,
  options: BuilderOptions,
  logger?: Logger,
  sink?: BuildEventSink,
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
