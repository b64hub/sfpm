import {PackageType} from '../index.js';
import {Logger} from './logger.js';

// ============================================================================
// Hook Context
// ============================================================================

export type PackageOperation = 'build' | 'install';
export type HookTiming = 'post' | 'pre';

export interface PackageContext {
  packageName: string;
  /**
   * Absolute path to the package's metadata directory.
   * Could be resolved from the local project source or from an extracted artifact.
   */
  packagePath: string;
  /** Package type identifier (e.g., 'Source', 'Unlocked') */
  packageType?: PackageType;
}

/**
 * Input provided to lifecycle hook handlers.
 *
 * Contains the minimum information guaranteed to be available at any
 * point in the lifecycle. Operation-specific integrations will extend this
 * with richer context (e.g., org connection, component set, resolved artifact)
 * when the lifecycle engine is wired into orchestrators.
 *
 * The index signature allows orchestrators to pass additional operation-specific
 * data without requiring type changes in core.
 */
export interface HookContext {
  /** Arbitrary operation-specific data — orchestrators extend this at integration time */
  [key: string]: unknown;
  /** The concrete operation being executed (e.g., 'build', 'install') */
  operation: PackageOperation;
  /** Current package name being processed */
  package: PackageContext;
  /** The lifecycle stage that triggered this invocation (e.g., 'validate', 'deploy', 'install', 'build') */
  stage: string;
  /**
   * Org alias or username that hooks can use to connect to the relevant org.
   *
   * - **Install operations**: the target org receiving the deployment
   * - **Build operations**: the default DevHub (if one was specified)
   *
   * Hooks that need a live connection can call `Org.create({ aliasOrUsername: targetOrg })`
   * from `@salesforce/core` to obtain one.
   */
  targetOrg?: string;
  /** The timing within the operation (e.g., 'pre', 'post') */
  timing: HookTiming;
}

// ============================================================================
// Hook Registration
// ============================================================================

/**
 * Options for controlling hook execution order and filtering.
 */
export interface HookOptions {
  /**
   * Optional filter predicate. If provided, the hook only runs
   * when the filter returns true for the given context.
   * Enables per-package or per-type control.
   */
  filter?: (context: HookContext) => boolean;

  /**
   * Per-hook ordering within a timing slot.
   * - `'first'`: runs before all other handlers
   * - `'last'`: runs after all other handlers
   * - `number`: explicit priority (lower numbers run first; default is `0`)
   * - `undefined`: equivalent to `0` — runs in registration order among other default hooks
   */
  order?: 'first' | 'last' | number;

  /**
   * Restrict this hook to specific lifecycle stages.
   * When omitted, the hook runs on **all** stages.
   * When set, the hook only executes when the engine's stage is in this list.
   *
   * @example `['deploy', 'local']` — skip during validate and provision
   */
  stages?: string[];
}

/**
 * A single hook registration combining an operation:timing target with a handler.
 */
export interface HookRegistration {
  /** The handler function to execute */
  handler: (context: HookContext) => Promise<void> | void;

  /** Operation name (e.g., 'build', 'install') */
  operation: string;

  /** Optional execution options (ordering, filtering, stage restriction) */
  options?: HookOptions;

  /**
   * Timing within the operation.
   * - `'pre'`: runs before the main operation action (sequential)
   * - `'post'`: runs after the main operation action (sequential)
   *
   * Modules may define custom timings for their own operations.
   */
  timing: string;
}

// ============================================================================
// Lifecycle Hooks Interface
// ============================================================================

/**
 * A named set of lifecycle hooks that participate in package lifecycle operations.
 *
 * `LifecycleHooks` is the lightweight extension mechanism for SFPM. It allows
 * modules (profiles, orgs, etc.) to inject behavior at specific points in the
 * package lifecycle without core depending on those modules.
 *
 * For broader extensibility (registering package types, builders, installers),
 * a separate extension mechanism will be designed in the future.
 *
 * @example
 * ```typescript
 * import { LifecycleHooks } from '@b64hub/sfpm-core';
 *
 * export function profileHooks(options?: ProfileOptions): LifecycleHooks {
 *   return {
 *     name: 'profiles',
 *     hooks: [
 *       {
 *         operation: 'install',
 *         timing: 'pre',
 *         handler: async (ctx) => {
 *           // runs before each package install
 *         },
 *       },
 *     ],
 *   };
 * }
 * ```
 */
export interface LifecycleHooks {
  /** The hook registrations provided by this module */
  hooks: HookRegistration[];

  /** Unique name identifying this set of hooks */
  name: string;
}
