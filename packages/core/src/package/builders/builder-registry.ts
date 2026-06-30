import type {Org} from '@salesforce/core';

import type {BuildEventSink} from '../../events/build-event-bus.js';

import {PendingValidationDescriptor, ValidationState} from '../../types/validation.js';
import {DependencyAnalyzer} from '../../types/dependency-analysis.js';
import {Logger} from '../../types/logger.js';
import {PackageType} from '../../types/package.js'
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
 * Result returned by a builder after execution.
 * Captures build output as explicit return values — builders
 * should not mutate sfpmPackage directly.
 */
export interface BuilderResult {
  /**
   * Effective package type as built — may differ from the project definition
   *  (e.g., unlocked built as source via --source-only)
   */
  packageType?: PackageType;
  /** Package version ID (04t) — set by unlocked package builds */
  packageVersionId?: string;
  /** Pending validation descriptor when validation was initiated asynchronously */
  pendingValidation?: PendingValidationDescriptor;
  /** Validation state to set on the package */
  validationState?: ValidationState;
  /** Resolved version string */
  version?: string;
}

/**
 * Interface for specific package builder implementations (Strategy Pattern).
 */
export interface Builder {
  /**
   * Connect to the target org (DevHub for unlocked, build org for source).
   * Optional — not all builds require an org connection.
   */
  connect(targetOrg: Org): Promise<void>;
  /**
   * Execute the build and return results.
   * Includes validation when applicable — no separate validate() call needed.
   */
  exec(): Promise<BuilderResult>;
  /**
   * Task registrations for pre/post build phases.
   * Registered by the builder in its constructor based on options.
   */
  readonly tasks: BuildTaskRegistration[];
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
  return (constructor: new (...args: any[]) => Builder) => {
    BuilderRegistry.register(type, constructor as BuilderConstructor);
  };
}

/**
 * Factory function to create a builder instance for a given package.
 *
 * @param sfpmPackage - The package to build
 * @param options - Builder options (validation, artifact, etc.)
 * @param logger - Optional logger
 * @param sink - Optional build event sink
 * @param buildAs - Override the package type used for builder lookup.
 *   Allows dry-run to route unlocked packages through the source builder.
 * @returns A configured builder instance
 */
export function builderFactory(
  sfpmPackage: SfpmPackage,
  options: BuilderOptions,
  logger?: Logger,
  sink?: BuildEventSink,
  buildAs?: PackageType,
): Builder {
  const packageType = buildAs ?? sfpmPackage.type;

  const BuilderClass = BuilderRegistry.getBuilder(packageType);
  if (!BuilderClass) {
    throw new Error(`No builder registered for package type: ${sfpmPackage.type}`);
  }

  if (!sfpmPackage.workingDirectory) {
    throw new Error('Package must be staged before building');
  }

  return new BuilderClass(
    sfpmPackage.workingDirectory,
    sfpmPackage,
    options,
    logger,
    sink,
  );
}
