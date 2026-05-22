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
 * Callback that produces the title for a Listr level task once the
 * `orchestration:level:start` event has fired.
 */
export type LevelTitleFn = (event: OrchestrationLevelStartEvent) => string;

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
  private levelDeferreds: Deferred[] = [];
  private readonly levelTitleFn: LevelTitleFn;
  /**
   * Pre-created deferreds for each package in the *current* level.
   * Populated synchronously in `onLevelStart` so resolve/reject are
   * available immediately, even before Listr sub-tasks set up `packageTasks`.
   */
  private packageDeferreds: Map<string, Deferred> = new Map();
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

  constructor(levelTitleFn: LevelTitleFn) {
    this.levelTitleFn = levelTitleFn;
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
  }

  /**
   * Look up the Listr sub-task for a package within the active orchestration level.
   * Returns `undefined` when no orchestration is running or the task hasn't
   * been registered yet.
   */
  public getPackageTask(packageName: string): any | undefined {
    return this.packageTasks.get(packageName);
  }

  // ==========================================================================
  // Package Task Helpers
  // ==========================================================================

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
    this.packageDeferreds.clear();
    this.packageTasks.clear();
    for (const name of event.packages) {
      this.packageDeferreds.set(name, createDeferred());
    }

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
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(error));
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  /**
   * Resolve the Listr sub-task promise for a package (marks it as done).
   */
  public resolvePackage(packageName: string): void {
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.resolve();
  }

  /**
   * Create the root Listr and fire-and-forget `run()`.
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
          await deferred.promise;
          const levelEvent = (deferred as any).data as OrchestrationLevelStartEvent;

          task.title = this.levelTitleFn(levelEvent);

          return task.newListr(
            levelEvent.packages.map((name: string) => {
              const detail = levelEvent.packageDetails?.find((d: any) => d.name === name);
              const version = detail?.version ? `@${detail.version}` : '';
              return {
                task: async (_c: any, _t: any) => {
                  this.packageTasks.set(name, _t);
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
}
