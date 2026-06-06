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
 * Manages a flat per-package Listr layout for build orchestration.
 *
 * Each package is a root-level concurrent Listr task with two sequential
 * sub-tasks:
 * 1. **Build** — covers staging → builder → tasks → artifact assembly
 * 2. **Validation queued** — static marker, only shown when validation
 *    was triggered during the build
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
 * manager.markValidationQueued(name);
 * manager.resolvePackage(name);
 *
 * // orchestration:complete
 * manager.destroy();
 * ```
 */
export class OrchestrationListrManager {
  /**
   * Build sub-task references keyed by package name — for phase title updates
   * (staging, connecting, creating version, etc.)
   */
  private buildSubtasks = new Map<string, any>();
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
   * Tear down the Listr instance and clear all deferred state.
   * Call from the `orchestration:complete` handler.
   */
  public destroy(): void {
    this.rootListr = undefined;
    this.packageDeferreds.clear();
    this.levelGates.clear();
    this.packageTasks.clear();
    this.buildSubtasks.clear();
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
   */
  public rejectPackage(packageName: string, error: string): void {
    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(error));
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
                task: async (_c: any, buildTask: any) => {
                  this.buildSubtasks.set(name, buildTask);
                  return this.packageDeferreds.get(name)!.promise;
                },
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

  // ==========================================================================
  // Title Helpers
  // ==========================================================================

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
}
