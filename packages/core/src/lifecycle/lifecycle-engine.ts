import EventEmitter from 'node:events';

import {
  HookContext,
  HookHandler,
  LifecycleHooks,
} from '../types/lifecycle.js';
import {isHookEnabled} from './hook-config.js';

const DEFAULT_STAGE = 'local';

// ============================================================================
// Internal Hook Entry
// ============================================================================

/**
 * Internal representation of a registered hook with sorting metadata.
 *
 * Sort order priority: hook order → insertion order.
 *
 * The sorting produces this execution order:
 * 1. Hooks with `order: 'first'` (registration order among themselves)
 * 2. Hooks with negative numeric order (ascending)
 * 3. Hooks without order / `order: 0` (registration order)
 * 4. Hooks with positive numeric order (ascending)
 * 5. Hooks with `order: 'last'` (registration order among themselves)
 */
interface RegisteredHook {
  /** Optional filter predicate */
  filter?: (context: HookContext) => boolean;
  /** The handler function to execute */
  handler: HookHandler;
  /** Name of the LifecycleHooks set that registered this hook */
  hooksName: string;
  /** Insertion index for stable sort tie-breaking */
  insertionIndex: number;
  /** The lifecycle operation (e.g., 'build', 'install') */
  operation: string;
  /** Resolved numeric priority for sorting */
  orderPriority: number;
  /** Lifecycle stages this hook applies to (empty = all stages) */
  stages: string[];
  /** The timing within the operation (e.g., 'pre', 'post') */
  timing: string;
}

function resolveOrderPriority(order: 'first' | 'last' | number | undefined): number {
  if (order === 'first') return -Infinity;
  if (order === 'last') return Infinity;
  return order ?? 0;
}

function sortHooks(hooks: RegisteredHook[]): RegisteredHook[] {
  return [...hooks].sort((left, right) => {
    const orderDiff = left.orderPriority - right.orderPriority;
    if (orderDiff !== 0) return orderDiff;

    return left.insertionIndex - right.insertionIndex;
  });
}

// ============================================================================
// Lifecycle Engine
// ============================================================================

/**
 * Lifecycle engine that manages hook registration and sequential execution.
 *
 * The engine is operation-agnostic — it does not define or enforce any specific
 * operations. Any `operation:timing` combination is valid; the engine simply stores
 * hooks and executes them when `run()` is called with a matching operation and
 * timing. Core orchestrators call `run('build', 'pre', ctx)` and
 * `run('install', 'post', ctx)`; other modules (orgs) can use their own
 * operations with the same engine.
 *
 * All hooks run **sequentially** in sorted order. For fire-and-forget
 * notifications, use the EventEmitter system instead.
 *
 * **Singleton-based** — each process initializes the engine once per execution.
 * The stage is fixed at initialization and reused for all hook runs.
 *
 * @example
 * ```typescript
 * const lifecycle = LifecycleEngine.stage('validate');
 *
 * // Register hooks
 * lifecycle.use(profileHooks({ reconcile: true }));
 *
 * // Execute hooks at the appropriate lifecycle point
 * await lifecycle.run('install', 'pre', context);
 * ```
 */
export class LifecycleEngine extends EventEmitter {
  private static initializedStage?: string;
  private static instance?: LifecycleEngine;
  private readonly _stage: string = DEFAULT_STAGE
  private readonly hooks: RegisteredHook[] = [];
  private insertionCounter = 0;

  private constructor(activeStage: string) {
    super();
    this._stage = activeStage;
  }

  /**
   * Get the initialized lifecycle singleton.
   */
  static getInstance(): LifecycleEngine {
    if (!LifecycleEngine.instance) {
      throw new Error('LifecycleEngine is not initialized. Call LifecycleEngine.stage(...) first.');
    }

    return LifecycleEngine.instance;
  }

  /**
   * Whether the lifecycle singleton has been initialized.
   */
  static isInitialized(): boolean {
    return LifecycleEngine.instance !== undefined;
  }

  /**
   * Test helper: clear singleton state between test cases.
   */
  static resetForTest(): void {
    LifecycleEngine.instance = undefined;
    LifecycleEngine.initializedStage = undefined;
  }

  /**
   * Initialize the process-wide lifecycle singleton for the given stage.
   *
   * The stage is fixed for the lifetime of the process. Calling `stage()`
   * again with the same value returns the existing instance. Calling with
   * a different value throws — each execution has exactly one stage.
   *
   * @param activeStage - The lifecycle stage (e.g., 'build', 'deploy', 'validate').
   *                      Defaults to 'local'.
   */
  static stage(activeStage?: string): LifecycleEngine {
    const resolvedStage = activeStage ?? DEFAULT_STAGE;

    if (!LifecycleEngine.instance) {
      LifecycleEngine.instance = new LifecycleEngine(resolvedStage);
      LifecycleEngine.initializedStage = resolvedStage;
      return LifecycleEngine.instance;
    }

    if (LifecycleEngine.initializedStage !== resolvedStage) {
      throw new Error(`LifecycleEngine already initialized with stage '${LifecycleEngine.initializedStage}'. `
        + `Cannot reinitialize with stage '${resolvedStage}'.`);
    }

    return LifecycleEngine.instance;
  }

  /** The lifecycle stage for this invocation (e.g., 'validate', 'deploy', 'local'). */
  get stage(): string {
    return this._stage;
  }

  // --------------------------------------------------------------------------
  // Hook Registration
  // --------------------------------------------------------------------------

  /**
   * Remove all registered hooks.
   */
  clear(): void {
    this.hooks.length = 0;
    this.insertionCounter = 0;
  }

  /**
   * Get all unique hook set names that have been registered.
   */
  getRegisteredHookNames(): string[] {
    return [...new Set(this.hooks.map(hook => hook.hooksName))];
  }

  /**
   * Get all unique operation names that have at least one hook registered.
   */
  getRegisteredOperations(): string[] {
    return [...new Set(this.hooks.map(hook => hook.operation))];
  }

  // --------------------------------------------------------------------------
  // Hook Execution
  // --------------------------------------------------------------------------

  /** Convenience shorthand for build:post hook checks. */
  hasBuildPostHooks(): boolean {
    return this.hasHooks('build', 'post');
  }

  /** Convenience shorthand for build:pre hook checks. */
  hasBuildPreHooks(): boolean {
    return this.hasHooks('build', 'pre');
  }

  /**
   * Check if any hooks are registered for a given operation and timing.
   * Useful for orchestrators to skip hook invocation overhead when no hooks exist.
   */
  hasHooks(operation: string, timing: string): boolean {
    return this.hooks.some(hook => hook.operation === operation && hook.timing === timing);
  }

  /** Convenience shorthand for install:post hook checks. */
  hasInstallPostHooks(): boolean {
    return this.hasHooks('install', 'post');
  }

  /** Convenience shorthand for install:pre hook checks. */
  hasInstallPreHooks(): boolean {
    return this.hasHooks('install', 'pre');
  }

  // --------------------------------------------------------------------------
  // Introspection
  // --------------------------------------------------------------------------

  /**
   * Remove all hooks registered under a given name.
   *
   * @param name - The `LifecycleHooks.name` used during `use()` registration
   * @returns The number of hooks removed
   */
  remove(name: string): number {
    let removed = 0;
    for (let index = this.hooks.length - 1; index >= 0; index--) {
      if (this.hooks[index].hooksName === name) {
        this.hooks.splice(index, 1);
        removed++;
      }
    }

    return removed;
  }

  /**
   * Execute all hooks registered for a given operation and timing, sequentially.
   *
   * Hooks are sorted by: order → insertion order.
   * Filtered hooks are skipped. If no hooks match, returns immediately.
   *
   * @param operation - The lifecycle operation (e.g., 'build', 'install')
   * @param timing - The timing within the operation (e.g., 'pre', 'post')
   * @param context - The hook context with package and environment information
   */
  async run(operation: string, timing: string, context: HookContext): Promise<void> {
    const enrichedContext = {...context, stage: this._stage};
    const matching = this.getMatchingHooks(operation, timing, enrichedContext);

    if (matching.length === 0) {
      return;
    }

    const packageName = context.sfpmPackage.name;
    const hookNames = matching.map(h => h.hooksName);

    context.logger?.debug(`Lifecycle: running ${matching.length} hook(s) for '${operation}:${timing}'`
      + ` on package '${packageName}'`
      + ` [stage=${this._stage}]`);

    this.emit('hooks:start', {
      hookCount: matching.length,
      hookNames,
      operation,
      packageName,
      timestamp: new Date(),
      timing,
    });

    for (const hook of matching) {
      try {
        // eslint-disable-next-line no-await-in-loop -- hooks must run sequentially in defined order
        await hook.handler(enrichedContext);

        this.emit('hook:complete', {
          hookName: hook.hooksName,
          operation,
          packageName,
          timestamp: new Date(),
          timing,
        });
      } catch (error) {
        context.logger?.error(`Lifecycle: hook from '${hook.hooksName}' failed `
          + `at '${hook.operation}:${hook.timing}'`
          + ` for package '${packageName}'`
          + `: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }

    this.emit('hooks:complete', {
      completedCount: matching.length,
      operation,
      packageName,
      timestamp: new Date(),
      timing,
    });
  }

  /** Execute build:post hooks with stage-enriched context. */
  async runBuildPost(context: HookContext): Promise<void> {
    await this.run('build', 'post', context);
  }

  /** Execute build:pre hooks with stage-enriched context. */
  async runBuildPre(context: HookContext): Promise<void> {
    await this.run('build', 'pre', context);
  }

  /** Execute install:post hooks with stage-enriched context. */
  async runInstallPost(context: HookContext): Promise<void> {
    await this.run('install', 'post', context);
  }

  /** Execute install:pre hooks with stage-enriched context. */
  async runInstallPre(context: HookContext): Promise<void> {
    await this.run('install', 'pre', context);
  }

  /**
   * Register a set of lifecycle hooks with the engine.
   *
   * Each `HookRegistration` in the set specifies the operation, timing, handler,
   * and optional ordering/filter options. The engine stores them internally
   * and executes them when `run()` is called with a matching operation and timing.
   */
  use(lifecycleHooks: LifecycleHooks): void {
    for (const registration of lifecycleHooks.hooks) {
      const entry: RegisteredHook = {
        filter: registration.options?.filter,
        handler: registration.handler,
        hooksName: lifecycleHooks.name,
        insertionIndex: this.insertionCounter++,
        operation: registration.operation,
        orderPriority: resolveOrderPriority(registration.options?.order),
        stages: registration.options?.stages ?? [],
        timing: registration.timing,
      };

      this.hooks.push(entry);
    }
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private getMatchingHooks(operation: string, timing: string, context: HookContext): RegisteredHook[] {
    const candidates = this.hooks.filter(hook => hook.operation === operation && hook.timing === timing);
    const sorted = sortHooks(candidates);
    const {logger} = context;

    // Apply stage, per-package enabled check, and filters
    return sorted.filter(hook => {
      // Check stage filter — if hook is restricted to specific stages, skip if not matching
      if (hook.stages.length > 0 && !hook.stages.includes(this._stage)) {
        logger?.debug(`Lifecycle: skipping hook from '${hook.hooksName}' for '${operation}:${timing}' — `
          + `stage '${this._stage}' not in [${hook.stages.join(', ')}]`);
        return false;
      }

      // Check per-package hook config — if disabled, skip without running filter
      if (!isHookEnabled(context, hook.hooksName)) {
        logger?.debug(`Lifecycle: skipping hook from '${hook.hooksName}' for '${operation}:${timing}' — `
          + 'disabled via packageOptions.hooks'
          + ` for package '${context.sfpmPackage.name}'`);
        return false;
      }

      // eslint-disable-next-line unicorn/no-array-callback-reference -- hook.filter is not Array.filter
      if (hook.filter && !hook.filter(context)) {
        logger?.debug(`Lifecycle: skipping hook from '${hook.hooksName}' for '${operation}:${timing}' — `
          + 'filter returned false'
          + ` for package '${context.sfpmPackage.name}'`);
        return false;
      }

      return true;
    });
  }
}
