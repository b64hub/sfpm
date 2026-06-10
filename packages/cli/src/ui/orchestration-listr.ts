import type {OrchestrationLevelStartEvent} from '@b64hub/sfpm-core';

import chalk from 'chalk';
import {Listr} from 'listr2';

// ============================================================================
// Deferred Promise Utility
// ============================================================================

/**
 * A deferred promise holder whose resolve/reject can be called externally.
 * Used to bridge event-driven orchestration with Listr's promise-based tasks.
 */
export interface Deferred {
  promise: Promise<void>;
  reject: (err: Error) => void;
  resolve: () => void;
}

/**
 * Create a new deferred promise.
 *
 * The returned object exposes `resolve` and `reject` so callers can settle
 * the promise from outside the executor — essential for wiring event handlers
 * to Listr sub-tasks.
 */
export function createDeferred(): Deferred {
  let resolve!: () => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {promise, reject, resolve};
}

// ============================================================================
// Orchestration Listr Manager
// ============================================================================

/**
 * Manages a flat per-package Listr layout for build/install orchestration.
 *
 * The goal is a **rich but concise** real-time overview: every package
 * gets just enough sub-tasks to show what's happening without drowning
 * the user in detail.  Hook phases (pre-/post-) surface as single
 * sub-tasks with a descriptive title; individual build phases update
 * a rolling title on the main build sub-task.
 *
 * ### Per-package layout
 *
 * ```
 * ├── @scope/name
 * │   ├── ⠋ running pre-build hooks — lint, prettier   (only while hooks run)
 * │   ├── ⠋ staging (42 components)...                  (rolling build title)
 * │   └── ◼ validation queued                           (optional)
 * ```
 *
 * Packages within a level run concurrently. Cross-level ordering is enforced
 * by per-package "level gate" deferreds that block until the level starts.
 *
 * On success, sub-tasks collapse and the root task shows the final state:
 * `✔ @scope/name @ 1.0.3 (1.6s)`. On failure, sub-tasks stay expanded.
 *
 * ## Typical usage
 *
 * ```ts
 * const manager = new OrchestrationListrManager();
 *
 * // orchestration:start
 * manager.start(['pkg-a', 'pkg-b', 'pkg-c']);
 *
 * // orchestration:level:start
 * manager.onLevelStart(event);
 *
 * // per-package events
 * manager.updateBuildTitle(name, 'staging (42 components)...');
 * manager.startHooks(name, ['lint', 'prettier'], 'pre', 'build');
 * manager.completeHooks(name, 2, 'pre', 'build', '1.2s');
 * manager.markValidationQueued(name);
 * manager.resolvePackage(name);
 *
 * // orchestration:complete
 * manager.destroy();
 * ```
 */
export class OrchestrationListrManager {
  /**
   * Active hook batch per package — one batch per hook phase (pre-/post-).
   * Holds the batch deferred (resolved by `completeHooks`) and the Listr
   * task reference (for title updates).
   */
  private activeHookBatches = new Map<string, {deferred: Deferred; task?: any}>();
  /**
   * Build sub-task references keyed by package name — for phase title updates
   * (staging, connecting, creating version, etc.)
   */
  private buildSubtasks = new Map<string, any>();
  /**
   * Per-package signal that a hook batch is ready to render.
   * Resolved by `startHooks()`, awaited by the build sub-task loop.
   */
  private hookSignals = new Map<string, Deferred>();
  /**
   * Per-package level gates — each package waits on its gate before starting.
   * Resolved in `onLevelStart()` when the package's level begins.
   */
  private levelGates = new Map<string, Deferred>();
  /**
   * One deferred per package — resolves when the package build completes.
   * Controls the build sub-task's Listr promise.
   */
  private packageDeferreds = new Map<string, Deferred>();
  /**
   * Root package task references keyed by package name — for setting
   * the collapsed title on completion.
   */
  private packageTasks = new Map<string, any>();
  /**
   * Hook batch info waiting to be consumed by the build sub-task loop.
   * Written by `startHooks()`, read by the build sub-task.
   */
  private pendingHooks = new Map<string, {hookNames: string[]; operation: string; timing: string}>();
  /**
   * Single root Listr instance. Created in `start()`, destroyed in `destroy()`.
   */
  private rootListr?: Listr;
  /**
   * Track which packages have validation queued.
   * Used by the validation sub-task's `enabled` callback.
   */
  private validationQueued = new Set<string>();

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Mark an individual hook as done within the active batch.
   * Currently a no-op — the batch resolves as a unit via {@link completeHooks}.
   * Kept as a stable call-site so renderers don't need to guard.
   */
  public completeHook(_packageName: string, _hookName: string): void {
    // Individual hook tracking intentionally omitted — one sub-task per phase.
  }

  /**
   * Resolve the active hook-phase sub-task and set its final title.
   * Called from the renderer's `hooks:complete` handler.
   */
  public completeHooks(packageName: string, completedCount: number, timing: string, operation: string, duration: string): void {
    const batch = this.activeHookBatches.get(packageName);
    if (!batch) return;

    if (batch.task) {
      const hookText = completedCount === 1 ? 'hook' : 'hooks';
      batch.task.title = `${timing}-${operation} ${hookText} (${completedCount}) ${chalk.gray(`(${duration})`)}`;
    }

    batch.deferred.resolve();
  }

  /**
   * Tear down the Listr instance and clear all deferred state.
   * Call from the `orchestration:complete` handler.
   */
  public destroy(): void {
    this.rootListr = undefined;
    this.packageDeferreds.clear();
    this.levelGates.clear();
    this.packageTasks.clear();
    this.buildSubtasks.clear();
    this.hookSignals.clear();
    this.pendingHooks.clear();
    this.activeHookBatches.clear();
    this.validationQueued.clear();
  }

  /**
   * Check if an orchestration is currently active.
   */
  public isActive(): boolean {
    return this.rootListr !== undefined;
  }

  /**
   * Mark a package as having validation queued.
   * This enables the `◼ validation queued` sub-task for the package.
   */
  public markValidationQueued(packageName: string): void {
    this.validationQueued.add(packageName);
  }

  /**
   * Handle `orchestration:level:start`.
   * Resolves the level gate for each package in this level,
   * unblocking their Listr tasks.
   */
  public onLevelStart(event: OrchestrationLevelStartEvent): void {
    for (const name of event.packages) {
      this.levelGates.get(name)?.resolve();
    }
  }

  /**
   * Reject the package build (marks the Listr task as failed).
   * Sub-tasks remain visible for failed packages.
   *
   * Also resolves any active hook deferreds and the hook signal
   * so the build sub-task loop can exit cleanly.
   */
  public rejectPackage(packageName: string, errorMessage: string): void {
    // Unblock any active hook batch so the loop can exit
    this.activeHookBatches.get(packageName)?.deferred.resolve();

    // Unblock the hook signal in case the loop is waiting
    this.hookSignals.get(packageName)?.resolve();
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(errorMessage));
  }

  /**
   * Resolve the package build (marks the Listr task as done).
   * Sub-tasks collapse when the parent resolves.
   */
  public resolvePackage(packageName: string): void {
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.resolve();
  }

  /**
   * Create the root Listr with all packages as concurrent tasks.
   * Each package awaits its level gate, then runs sub-tasks.
   *
   * @param packageNames — all packages, ordered by level
   */
  public start(packageNames: string[]): void {
    for (const name of packageNames) {
      this.packageDeferreds.set(name, createDeferred());
      this.levelGates.set(name, createDeferred());
      this.hookSignals.set(name, createDeferred());
    }

    this.rootListr = new Listr(
      packageNames.map(name => ({
        exitOnError: false,
        task: async (_ctx: any, parentTask: any): Promise<Listr> => {
          this.packageTasks.set(name, parentTask);

          // Block until this package's level starts
          await this.levelGates.get(name)!.promise;

          parentTask.title = chalk.cyan(name);

          return parentTask.newListr(
            [
              {
                task: async (_c: any, buildTask: any) => this.awaitNextPhase(name, buildTask),
                title: 'building...',
              },
              {
                enabled: () => this.validationQueued.has(name),
                task() {/* static marker — resolves immediately */},
                title: chalk.dim('validation queued'),
              },
            ],
            {
              concurrent: false,
              exitOnError: false,
            },
          );
        },
        title: chalk.dim(name),
      })),
      {
        concurrent: true,
        exitOnError: false,
        rendererOptions: {
          collapseErrors: false,
          collapseSubtasks: true,
        },
      },
    );

    this.rootListr.run().catch(() => {
      // Errors are handled by individual task handlers
    });
  }

  /**
   * Signal that a hook phase is about to run.
   * The build sub-task loop renders a single sub-task for the batch,
   * resolved by {@link completeHooks} when all hooks finish.
   */
  public startHooks(packageName: string, hookNames: string[], timing: string, operation: string): void {
    this.pendingHooks.set(packageName, {hookNames, operation, timing});
    this.hookSignals.get(packageName)?.resolve();
  }

  /**
   * Update the build sub-task title (for phase updates: staging, connecting, etc.)
   * No-op if the sub-task hasn't been registered yet.
   */
  public updateBuildTitle(packageName: string, title: string): void {
    const task = this.buildSubtasks.get(packageName);
    if (task) task.title = title;
  }

  /**
   * Update the root package task title (for the collapsed final state).
   * No-op if the task hasn't been registered yet.
   */
  public updatePackageTitle(packageName: string, title: string): void {
    const task = this.packageTasks.get(packageName);
    if (task) task.title = title;
  }

  // ==========================================================================
  // Private Helpers
  // ==========================================================================

  /**
   * Wait for package completion **or** a hook-batch signal.
   *
   * - If the package settles first the task resolves/rejects normally.
   * - If a hook signal arrives, returns a Listr (from
   *   {@link createHookSubtasks}) so Listr2 renders hook + continuation
   *   sub-tasks nested under the current build task.
   *
   * The "looping" happens via recursion: the continuation task inside
   * {@link createHookSubtasks} calls back into `awaitNextPhase`,
   * so each hook phase adds one level of nesting that collapses on
   * completion.
   */
  private async awaitNextPhase(packageName: string, buildTask: any): Promise<Listr | void> {
    this.buildSubtasks.set(packageName, buildTask);

    // Wrap the package promise so Promise.race never throws
    const pkgDone = this.packageDeferreds.get(packageName)!.promise
    .then(
      () => ({type: 'done'} as const),
      (error: Error) => ({error, type: 'error' as const}),
    );

    const hookSignal = this.hookSignals.get(packageName)!;

    const result = await Promise.race([
      pkgDone,
      hookSignal.promise.then(() => ({type: 'hooks'} as const)),
    ]);

    if (result.type === 'done') return;
    if (result.type === 'error') throw result.error;

    // Hook signal received — return subtasks if a batch is pending
    const hookListr = this.createHookSubtasks(packageName, buildTask);
    if (hookListr) return hookListr;

    // Spurious signal (e.g. from rejectPackage cleanup) — await package result
    const final = await pkgDone;
    if (final.type === 'error') throw final.error;
  }

  /**
   * Create a Listr with the hook-phase sub-task followed by a build
   * continuation that re-enters {@link awaitNextPhase}.
   *
   * Returns the Listr to be **returned** (not `.run()`'d) from the
   * parent task function so Listr2 renders it nested under the parent.
   *
   * Returns `undefined` if no hooks are actually pending (spurious signal).
   */
  private createHookSubtasks(packageName: string, buildTask: any): Listr | undefined {
    const hookInfo = this.pendingHooks.get(packageName);
    if (!hookInfo) return undefined;
    this.pendingHooks.delete(packageName);

    const batchDeferred = createDeferred();
    const hookNamesLabel = hookInfo.hookNames.map(n => chalk.dim(n)).join(chalk.dim(', '));
    const phaseLabel = `${hookInfo.timing}-${hookInfo.operation}`;

    return buildTask.newListr(
      [
        {
          task: async (_: any, hookTask: any) => {
            this.activeHookBatches.set(packageName, {deferred: batchDeferred, task: hookTask});
            return batchDeferred.promise;
          },
          title: `running ${phaseLabel} hooks ${chalk.dim('\u2014')} ${hookNamesLabel}`,
        },
        {
          task: async (_: any, nextBuildTask: any) => {
            this.activeHookBatches.delete(packageName);
            this.hookSignals.set(packageName, createDeferred());
            return this.awaitNextPhase(packageName, nextBuildTask);
          },
          title: 'building...',
        },
      ],
      {concurrent: false, exitOnError: false},
    ) as Listr;
  }
}
