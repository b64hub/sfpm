import {
  HookContext,
  HookHandler,
  LifecycleHooks,
} from '../types/lifecycle.js';
import {Logger} from '../types/logger.js';
import {isHookEnabled} from './hook-config.js';
import {DEFAULT_STAGE} from './stages.js';

// ============================================================================
// Internal Hook Entry
// ============================================================================

/**
 * Internal representation of a registered hook with sorting metadata.
 *
 * Sort order priority: set enforce → hook order → insertion order.
 *
 * The sorting produces this execution order:
 * 1. Sets with `enforce: 'pre'`  + hooks with `order: 'pre'`
 * 2. Sets with `enforce: 'pre'`  + hooks without order
 * 3. Sets with `enforce: 'pre'`  + hooks with `order: 'post'`
 * 4. Normal sets + hooks with `order: 'pre'`
 * 5. Normal sets + hooks without order
 * 6. Normal sets + hooks with `order: 'post'`
 * 7. Sets with `enforce: 'post'` + hooks with `order: 'pre'`
 * 8. Sets with `enforce: 'post'` + hooks without order
 * 9. Sets with `enforce: 'post'` + hooks with `order: 'post'`
 */
interface RegisteredHook {
  /** Set-level ordering from LifecycleHooks.enforce */
  enforce: 'default' | 'post' | 'pre';
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
  /** Per-hook ordering within a timing slot */
  order: 'default' | 'post' | 'pre';
  /** Lifecycle stages this hook applies to (empty = all stages) */
  stages: string[];
  /** The timing within the operation (e.g., 'pre', 'post') */
  timing: string;
}

const ENFORCE_PRIORITY: Record<string, number> = {default: 1, post: 2, pre: 0};
const ORDER_PRIORITY: Record<string, number> = {default: 1, post: 2, pre: 0};

function sortHooks(hooks: RegisteredHook[]): RegisteredHook[] {
  return [...hooks].sort((a, b) => {
    const enforceDiff = ENFORCE_PRIORITY[a.enforce] - ENFORCE_PRIORITY[b.enforce];
    if (enforceDiff !== 0) return enforceDiff;

    const orderDiff = ORDER_PRIORITY[a.order] - ORDER_PRIORITY[b.order];
    if (orderDiff !== 0) return orderDiff;

    return a.insertionIndex - b.insertionIndex;
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
 * **Instance-based** — each CLI command invocation creates its own engine.
 * No global state, no cleanup needed between tests.
 *
 * @example
 * ```typescript
 * const lifecycle = new LifecycleEngine({ stage: 'validate' });
 *
 * // Register hooks
 * lifecycle.use(profileHooks({ reconcile: true }));
 *
 * // Execute hooks at the appropriate lifecycle point
 * await lifecycle.run('install', 'pre', context);
 * ```
 */
export class LifecycleEngine {
  private readonly _stage: string;
  private readonly hooks: RegisteredHook[] = [];
  private insertionCounter = 0;
  private readonly logger?: Logger;

  constructor(options?: {logger?: Logger; stage?: string}) {
    this.logger = options?.logger;
    this._stage = options?.stage ?? DEFAULT_STAGE;
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
    this.logger?.debug('Lifecycle: cleared all hooks');
  }

  /**
   * Get all unique hook set names that have been registered.
   */
  getRegisteredHookNames(): string[] {
    return [...new Set(this.hooks.map(h => h.hooksName))];
  }

  /**
   * Get all unique operation names that have at least one hook registered.
   */
  getRegisteredOperations(): string[] {
    return [...new Set(this.hooks.map(h => h.operation))];
  }

  // --------------------------------------------------------------------------
  // Hook Execution
  // --------------------------------------------------------------------------

  /**
   * Check if any hooks are registered for a given operation and timing.
   * Useful for orchestrators to skip hook invocation overhead when no hooks exist.
   */
  hasHooks(operation: string, timing: string): boolean {
    return this.hooks.some(h => h.operation === operation && h.timing === timing);
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
    for (let i = this.hooks.length - 1; i >= 0; i--) {
      if (this.hooks[i].hooksName === name) {
        this.hooks.splice(i, 1);
        removed++;
      }
    }

    if (removed > 0) {
      this.logger?.debug(`Lifecycle: removed ${removed} hook(s) for '${name}'`);
    }

    return removed;
  }

  /**
   * Execute all hooks registered for a given operation and timing, sequentially.
   *
   * Hooks are sorted by: enforce → order → insertion order.
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

    this.logger?.debug(`Lifecycle: running ${matching.length} hook(s) for '${operation}:${timing}'`
      + (context.packageName ? ` on package '${context.packageName}'` : '')
      + ` [stage=${this._stage}]`);

    for (const hook of matching) {
      try {
        // eslint-disable-next-line no-await-in-loop -- hooks must run sequentially in defined order
        await hook.handler(enrichedContext);
      } catch (error) {
        this.logger?.error(`Lifecycle: hook from '${hook.hooksName}' failed `
          + `at '${hook.operation}:${hook.timing}'`
          + (context.packageName ? ` for package '${context.packageName}'` : '')
          + `: ${error instanceof Error ? error.message : String(error)}`);
        throw error;
      }
    }
  }

  /**
   * Register a set of lifecycle hooks with the engine.
   *
   * Each `HookRegistration` in the set specifies the operation, timing, handler,
   * and optional ordering/filter options. The engine stores them internally
   * and executes them when `run()` is called with a matching operation and timing.
   */
  use(lifecycleHooks: LifecycleHooks): void {
    const enforce = lifecycleHooks.enforce ?? 'default';

    for (const registration of lifecycleHooks.hooks) {
      const entry: RegisteredHook = {
        enforce,
        filter: registration.options?.filter,
        handler: registration.handler,
        hooksName: lifecycleHooks.name,
        insertionIndex: this.insertionCounter++,
        operation: registration.operation,
        order: registration.options?.order ?? 'default',
        stages: registration.options?.stages ?? [],
        timing: registration.timing,
      };

      this.hooks.push(entry);
    }

    this.logger?.debug(`Lifecycle: registered '${lifecycleHooks.name}' with ${lifecycleHooks.hooks.length} hook(s)`);
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private getMatchingHooks(operation: string, timing: string, context: HookContext): RegisteredHook[] {
    const candidates = this.hooks.filter(h => h.operation === operation && h.timing === timing);
    const sorted = sortHooks(candidates);

    // Apply stage, per-package enabled check, and filters
    return sorted.filter(h => {
      // Check stage filter — if hook is restricted to specific stages, skip if not matching
      if (h.stages.length > 0 && !h.stages.includes(this._stage)) {
        this.logger?.debug(`Lifecycle: skipping hook from '${h.hooksName}' for '${operation}:${timing}' — `
          + `stage '${this._stage}' not in [${h.stages.join(', ')}]`);
        return false;
      }

      // Check per-package hook config — if disabled, skip without running filter
      if (!isHookEnabled(context, h.hooksName)) {
        this.logger?.debug(`Lifecycle: skipping hook from '${h.hooksName}' for '${operation}:${timing}' — `
          + 'disabled via packageOptions.hooks'
          + (context.packageName ? ` for package '${context.packageName}'` : ''));
        return false;
      }

      // eslint-disable-next-line unicorn/no-array-callback-reference -- h.filter is not Array.filter
      if (h.filter && !h.filter(context)) {
        this.logger?.debug(`Lifecycle: skipping hook from '${h.hooksName}' for '${operation}:${timing}' — `
          + 'filter returned false'
          + (context.packageName ? ` for package '${context.packageName}'` : ''));
        return false;
      }

      return true;
    });
  }
}
