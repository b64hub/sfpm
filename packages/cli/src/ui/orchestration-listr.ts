import type {OrchestrationLevelStartEvent} from '@b64/sfpm-core';

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
 * Callback that produces the title for a Listr level task once the
 * `orchestration:level:start` event has fired.
 */
export type LevelTitleFn = (event: OrchestrationLevelStartEvent) => string;

/**
 * Describes a single subtask to nest under a package task.
 */
export interface SubtaskConfig {
  name: string;
  title: string;
}

/**
 * Manages the lifecycle of a single root Listr instance used by an
 * orchestration renderer (build or install).
 *
 * Encapsulates the level-deferred / package-deferred wiring so renderers
 * only need to call high-level methods and supply a title callback.
 *
 * ## Typical usage
 *
 * ```ts
 * const manager = new OrchestrationListrManager(levelTitleFn);
 *
 * // orchestration:start
 * manager.start(event.totalLevels);
 *
 * // orchestration:level:start
 * manager.onLevelStart(event);
 *
 * // per-package events
 * manager.updatePackageTitle(name, title);
 * manager.resolvePackage(name);
 *
 * // orchestration:complete
 * manager.destroy();
 * ```
 */
export class OrchestrationListrManager {
  /**
   * One deferred per orchestration level — resolved when
   * `orchestration:level:start` fires to unblock the Listr level task.
   */
  private readonly enableSubtasks: boolean;
  private levelDeferreds: Deferred[] = [];
  private readonly levelTitleFn: LevelTitleFn;
  /**
   * Pre-created deferreds for each package in the *current* level.
   * Populated synchronously in `onLevelStart` so resolve/reject are
   * available immediately, even before Listr sub-tasks set up `packageTasks`.
   */
  private packageDeferreds: Map<string, Deferred> = new Map();
  /**
   * Structure deferreds — resolved when the renderer knows the subtask
   * layout for a package (e.g. after all `analyzer:start` events).
   * Only populated when `enableSubtasks` is true.
   */
  private packageStructureDeferreds: Map<string, Deferred> = new Map();
  /**
   * Listr sub-task references keyed by package name.
   * Populated lazily as each Listr package task executes.
   */
  private packageTasks: Map<string, any> = new Map();
  /**
   * Single root Listr instance that persists across all orchestration levels.
   * Created in `start()`, destroyed in `destroy()`.
   */
  private rootListr?: Listr;
  /**
   * Sentinel task references keyed by package name.
   * The sentinel keeps the sub-Listr alive after all named subtasks resolve.
   * Initially title-less (invisible); the renderer can give it a visible
   * title so listr2 renders a spinner during post-subtask phases.
   */
  private sentinelTasks: Map<string, any> = new Map();
  /**
   * Per-package, per-subtask deferreds. Created synchronously in
   * `setPackageSubtasks` so they're available before Listr tasks execute.
   */
  private subtaskDeferreds: Map<string, Map<string, Deferred>> = new Map();
  /**
   * Per-package, per-subtask Listr task references.
   * Populated lazily as each subtask executes.
   */
  private subtaskTasks: Map<string, Map<string, any>> = new Map();

  constructor(levelTitleFn: LevelTitleFn, options?: {enableSubtasks?: boolean}) {
    this.levelTitleFn = levelTitleFn;
    this.enableSubtasks = options?.enableSubtasks ?? false;
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Tear down the Listr instance and clear all deferred state.
   *
   * Call this from the `orchestration:complete` handler.
   */
  public destroy(): void {
    this.rootListr = undefined;
    this.levelDeferreds = [];
    this.packageDeferreds.clear();
    this.packageTasks.clear();
    this.packageStructureDeferreds.clear();
    this.sentinelTasks.clear();
    this.subtaskDeferreds.clear();
    this.subtaskTasks.clear();
  }

  /**
   * Look up the Listr sub-task for a package within the active orchestration level.
   * Returns `undefined` when no orchestration is running or the task hasn't
   * been registered yet.
   */
  public getPackageTask(packageName: string): any | undefined {
    return this.packageTasks.get(packageName);
  }

  /**
   * Look up the Listr sub-task for a named subtask within a package.
   * Returns `undefined` when the package has no subtasks or the task
   * hasn't started yet.
   */
  public getSubtaskTask(packageName: string, subtaskName: string): any | undefined {
    return this.subtaskTasks.get(packageName)?.get(subtaskName);
  }

  // ==========================================================================
  // Package Task Helpers
  // ==========================================================================

  /**
   * Whether a package has active subtasks (e.g. analyzer sub-tasks).
   */
  public hasSubtasks(packageName: string): boolean {
    return (this.subtaskDeferreds.get(packageName)?.size ?? 0) > 0;
  }

  /**
   * Check if an orchestration is currently active.
   *
   * Used to prevent standalone spinner creation during orchestration —
   * all output should flow through Listr sub-tasks instead.
   */
  public isActive(): boolean {
    return this.rootListr !== undefined;
  }

  /**
   * Handle `orchestration:level:start`.
   *
   * Creates package deferreds synchronously and then resolves the
   * corresponding level deferred to unblock the Listr level task.
   */
  public onLevelStart(event: OrchestrationLevelStartEvent): void {
    // Pre-create package deferreds SYNCHRONOUSLY so resolve/reject are
    // available immediately, even if domain events fire before Listr
    // sub-tasks populate the packageTasks map.
    this.packageDeferreds.clear();
    this.packageTasks.clear();
    this.packageStructureDeferreds.clear();
    this.sentinelTasks.clear();
    this.subtaskDeferreds.clear();
    this.subtaskTasks.clear();
    for (const name of event.packages) {
      this.packageDeferreds.set(name, createDeferred());
      if (this.enableSubtasks) {
        this.packageStructureDeferreds.set(name, createDeferred());
      }
    }

    // Resolve the level deferred to unblock the corresponding Listr level task.
    const levelDeferred = this.levelDeferreds[event.level];
    if (levelDeferred) {
      (levelDeferred as any).data = event;
      levelDeferred.resolve();
    }
  }

  /**
   * Reject the Listr sub-task promise for a package (marks it as failed).
   * Uses the pre-created deferred — safe to call even before Listr has
   * populated the packageTasks map.
   */
  public rejectPackage(packageName: string, error: string): void {
    // Ensure the structure deferred is settled to unblock the package task
    this.skipPackageSubtasks(packageName);
    // Reject any pending subtask deferreds
    const subtaskDefs = this.subtaskDeferreds.get(packageName);
    if (subtaskDefs) {
      for (const deferred of subtaskDefs.values()) {
        deferred.reject(new Error(error));
      }
    }

    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(error));
  }

  /**
   * Reject a specific subtask (marks it as failed in the Listr UI).
   * Safe to call before the subtask's Listr task has started.
   */
  public rejectSubtask(packageName: string, subtaskName: string, error: string): void {
    const deferred = this.subtaskDeferreds.get(packageName)?.get(subtaskName);
    if (deferred) deferred.reject(new Error(error));
  }

  // ==========================================================================
  // Subtask Management
  // ==========================================================================

  /**
   * Resolve the Listr sub-task promise for a package (marks it as done).
   * Uses the pre-created deferred — safe to call even before Listr has
   * populated the packageTasks map.
   */
  public resolvePackage(packageName: string): void {
    // Resolve any pending subtask deferreds
    const subtaskDefs = this.subtaskDeferreds.get(packageName);
    if (subtaskDefs) {
      for (const deferred of subtaskDefs.values()) {
        deferred.resolve();
      }
    }

    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.resolve();
  }

  /**
   * Resolve a specific subtask (marks it as done in the Listr UI).
   * Safe to call before the subtask's Listr task has started.
   */
  public resolveSubtask(packageName: string, subtaskName: string): void {
    const deferred = this.subtaskDeferreds.get(packageName)?.get(subtaskName);
    if (deferred) deferred.resolve();
  }

  /**
   * Declare the subtask structure for a package and unblock the package
   * task so it can create the sub-Listr.
   *
   * Creates subtask deferreds **synchronously** so that `resolveSubtask`
   * / `rejectSubtask` are safe to call immediately—even before the Listr
   * subtask functions execute.
   *
   * No-op if subtasks have already been set for this package.
   */
  public setPackageSubtasks(packageName: string, subtasks: SubtaskConfig[]): void {
    const deferred = this.packageStructureDeferreds.get(packageName);
    if (!deferred || (deferred as any).settled) return;
    (deferred as any).settled = true;

    // Pre-create subtask deferreds so resolve/reject are available immediately
    if (subtasks.length > 0) {
      const defs = new Map<string, Deferred>();
      for (const st of subtasks) {
        defs.set(st.name, createDeferred());
      }

      this.subtaskDeferreds.set(packageName, defs);
      this.subtaskTasks.set(packageName, new Map());
    }

    (deferred as any).data = {subtasks};
    deferred.resolve();
  }

  /**
   * Convenience method — resolves the structure deferred with an empty
   * subtask list. Call this when a package will not have nested subtasks
   * (e.g. Data packages or 0-analyzer builds).
   */
  public skipPackageSubtasks(packageName: string): void {
    this.setPackageSubtasks(packageName, []);
  }

  /**
   * Create the root Listr and fire-and-forget `run()`.
   *
   * Call this from the `orchestration:start` handler **after** any header
   * messages have been logged.
   *
   * @param totalLevels — number of orchestration levels (from OrchestrationStartEvent)
   */
  public start(totalLevels: number): void {
    this.levelDeferreds = [];
    for (let i = 0; i < totalLevels; i++) {
      this.levelDeferreds.push(createDeferred());
    }

    this.rootListr = new Listr(
      this.levelDeferreds.map((deferred, i) => ({
        task: async (_ctx: any, task: any): Promise<Listr> => {
          // Block until orchestration:level:start resolves this deferred
          await deferred.promise;
          const levelEvent = (deferred as any).data as OrchestrationLevelStartEvent;

          // Update the level title via the renderer-supplied callback
          task.title = this.levelTitleFn(levelEvent);

          // Build concurrent subtasks — packageDeferreds are already populated
          // synchronously in onLevelStart before the level deferred was resolved.
          return task.newListr(
            levelEvent.packages.map((name: string) => {
              const detail = levelEvent.packageDetails?.find((d: any) => d.name === name);
              const version = detail?.version ? `@${detail.version}` : '';
              return {
                task: async (_c: any, _t: any) => {
                  this.packageTasks.set(name, _t);

                  // When subtask support is enabled, wait for the renderer to
                  // declare the subtask structure (e.g. analyzer names).
                  if (this.enableSubtasks) {
                    const structureDeferred = this.packageStructureDeferreds.get(name);
                    if (structureDeferred) {
                      await structureDeferred.promise;
                      const structure = (structureDeferred as any).data as {subtasks: SubtaskConfig[]};

                      if (structure.subtasks.length > 0) {
                        const pkgSubtaskDefs = this.subtaskDeferreds.get(name)!;
                        const pkgSubtaskTasks = this.subtaskTasks.get(name)!;

                        return _t.newListr(
                          [
                            ...structure.subtasks.map((st: SubtaskConfig) => ({
                              task(_c2: any, _t2: any) {
                                pkgSubtaskTasks.set(st.name, _t2);
                                return pkgSubtaskDefs.get(st.name)!.promise;
                              },
                              title: st.title,
                            })),
                            {
                              // Sentinel task — keeps the sub-Listr alive until the
                            // package fully completes. Initially title-less
                            // (invisible); the renderer gives it a visible title
                            // during post-subtask phases so a spinner appears.
                              task: (_c3: any, _t3: any) => {
                                this.sentinelTasks.set(name, _t3);
                                return this.packageDeferreds.get(name)!.promise;
                              },
                              title: '' as any,
                            },
                          ],
                          {concurrent: true, exitOnError: false},
                        );
                      }
                    }
                  }

                  return this.packageDeferreds.get(name)!.promise;
                },
                title: `${chalk.cyan(`${name}${version}`)}`,
              };
            }),
            {
              concurrent: true,
              exitOnError: false,
              rendererOptions: {
                collapseErrors: false,
              },
            },
          );
        },
        title: chalk.dim(`Level ${i + 1} - waiting...`),
      })),
      {
        concurrent: false,
        rendererOptions: {
          collapseSubtasks: false,
        },
      },
    );

    this.rootListr.run().catch(() => {
      // Errors are handled by individual task handlers
    });
  }

  /**
   * Update the title of a package's Listr sub-task.
   * No-op if the task hasn't been registered.
   */
  public updatePackageTitle(packageName: string, title: string): void {
    const task = this.packageTasks.get(packageName);
    if (task) {
      task.title = title;
    }
  }

  /**
   * Update the title of the sentinel task for a package.
   * Once a non-empty title is set, the sentinel becomes visible in the
   * Listr UI and renders with a spinner — useful for post-subtask phases
   * (e.g. package version creation) where all named subtasks are already
   * complete.
   *
   * No-op if the sentinel task hasn't been registered yet.
   */
  public updateSentinelTitle(packageName: string, title: string): void {
    const task = this.sentinelTasks.get(packageName);
    if (task) {
      task.title = title;
    }
  }

  /**
   * Update the title of a named subtask within a package.
   * No-op if the subtask task hasn't been registered yet.
   */
  public updateSubtaskTitle(packageName: string, subtaskName: string, title: string): void {
    const task = this.subtaskTasks.get(packageName)?.get(subtaskName);
    if (task) {
      task.title = title;
    }
  }
}
