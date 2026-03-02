import {Logger} from './logger.js';

// ============================================================================
// Hook Context
// ============================================================================

/**
 * Context provided to lifecycle hook handlers.
 *
 * Contains the minimum information guaranteed to be available at any
 * point in the lifecycle. Phase-specific integrations will extend this
 * with richer context (e.g., org connection, component set, resolved artifact)
 * when the lifecycle engine is wired into orchestrators.
 *
 * The index signature allows orchestrators to pass additional phase-specific
 * data without requiring type changes in core.
 */
export interface HookContext {
  /** The lifecycle phase being executed (e.g., 'build', 'install') */
  phase: string;
  /** The timing within the phase (e.g., 'pre', 'post') */
  timing: string;
  /** Current package name being processed */
  packageName?: string;
  /** Package type identifier (e.g., 'Source', 'Unlocked') */
  packageType?: string;
  /** Project root directory */
  projectDir?: string;
  /** Logger instance for the current operation */
  logger?: Logger;
  /** Arbitrary phase-specific data — orchestrators extend this at integration time */
  [key: string]: unknown;
}

// ============================================================================
// Hook Handlers
// ============================================================================

/**
 * A function that handles a lifecycle hook invocation.
 * Handlers are awaited — they run as part of the process, not as observers.
 */
export type HookHandler = (context: HookContext) => Promise<void> | void;

// ============================================================================
// Hook Registration
// ============================================================================

/**
 * Options for controlling hook execution order and filtering.
 */
export interface HookOptions {
  /**
   * Per-hook ordering within a timing slot.
   * - `'pre'`: runs before default-ordered handlers
   * - `'post'`: runs after default-ordered handlers
   * - `undefined`: runs in registration order between 'pre' and 'post'
   */
  order?: 'pre' | 'post';

  /**
   * Optional filter predicate. If provided, the hook only runs
   * when the filter returns true for the given context.
   * Enables per-package or per-type control.
   */
  filter?: (context: HookContext) => boolean;
}

/**
 * A single hook registration combining a phase:timing target with a handler.
 */
export interface HookRegistration {
  /** Phase name (e.g., 'build', 'install', 'validate', 'prepare') */
  phase: string;

  /**
   * Timing within the phase.
   * - `'pre'`: runs before the main phase action (sequential)
   * - `'post'`: runs after the main phase action (sequential)
   *
   * Modules may define custom timings for their own phases.
   */
  timing: string;

  /** The handler function to execute */
  handler: HookHandler;

  /** Optional execution options (ordering, filtering) */
  options?: HookOptions;
}

// ============================================================================
// Lifecycle Hooks Interface
// ============================================================================

/**
 * A named set of lifecycle hooks that participate in package lifecycle phases.
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
 * import { LifecycleHooks } from '@b64/sfpm-core';
 *
 * export function profileHooks(options?: ProfileOptions): LifecycleHooks {
 *   return {
 *     name: 'profiles',
 *     hooks: [
 *       {
 *         phase: 'install',
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
  /** Unique name identifying this set of hooks */
  name: string;

  /**
   * Set-level ordering. Sets with `enforce: 'pre'` have all their hooks
   * run before normal sets; `enforce: 'post'` run after.
   */
  enforce?: 'pre' | 'post';

  /** The hook registrations provided by this module */
  hooks: HookRegistration[];
}
