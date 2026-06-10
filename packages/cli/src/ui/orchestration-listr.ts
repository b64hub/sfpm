import type {OrchestrationLevelStartEvent} from '@b64hub/sfpm-core';

import chalk from 'chalk';
import {Listr} from 'listr2';

// ============================================================================
// Deferred Promise Utility
// ============================================================================

export interface Deferred {
  promise: Promise<void>;
  reject: (err: Error) => void;
  resolve: () => void;
}

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
// Hook Slot
// ============================================================================

interface HookSlot {
  activated: boolean;
  deferred: Deferred;
  skipped: boolean;
  task?: any;
}

function createHookSlot(): HookSlot {
  return {activated: false, deferred: createDeferred(), skipped: false};
}

// ============================================================================
// Orchestration Listr Manager
// ============================================================================

/**
 * Manages a flat per-package Listr layout for build/install orchestration.
 *
 * Each package gets four pre-allocated **sequential** sibling sub-tasks:
 *
 * ```
 * ├── @scope/name
 * │   ├── ✔ pre-build hooks (2) (528ms)       or → [SKIPPED]
 * │   ├── ⠋ staging (42 components)...         rolling build title
 * │   ├── ✔ post-build hooks (1) (320ms)       or → [SKIPPED]
 * │   └── ◼ validation queued                  optional
 * ```
 *
 * Hook slots that don't fire are displayed as skipped — they are part
 * of the framework and safe to show.  Build phases (staging, connecting,
 * creating version, …) update the build task title in place.
 */
export class OrchestrationListrManager {
  private buildSubtasks = new Map<string, any>();
  private hookSlots = new Map<string, HookSlot>();
  private levelGates = new Map<string, Deferred>();
  private packageDeferreds = new Map<string, Deferred>();
  private packageTasks = new Map<string, any>();
  private rootListr?: Listr;
  private validationQueued = new Set<string>();

  // ==========================================================================
  // Public API
  // ==========================================================================

  public completeHook(_packageName: string, _hookName: string): void {
    // no-op — one sub-task per phase
  }

  public completeHooks(packageName: string, completedCount: number, timing: string, operation: string, duration: string): void {
    const slot = this.hookSlots.get(`${packageName}:${timing}`);
    if (!slot) return;

    if (slot.task) {
      const hookText = completedCount === 1 ? 'hook' : 'hooks';
      slot.task.title = `${timing}-${operation} ${hookText} (${completedCount}) ${chalk.gray(`(${duration})`)}`;
    }

    slot.deferred.resolve();
  }

  public destroy(): void {
    this.rootListr = undefined;
    this.packageDeferreds.clear();
    this.levelGates.clear();
    this.packageTasks.clear();
    this.buildSubtasks.clear();
    this.hookSlots.clear();
    this.validationQueued.clear();
  }

  public isActive(): boolean {
    return this.rootListr !== undefined;
  }

  public markValidationQueued(packageName: string): void {
    this.validationQueued.add(packageName);
  }

  public onLevelStart(event: OrchestrationLevelStartEvent): void {
    for (const name of event.packages) {
      this.levelGates.get(name)?.resolve();
    }
  }

  public rejectPackage(packageName: string, errorMessage: string): void {
    for (const timing of ['pre', 'post']) {
      const slot = this.hookSlots.get(`${packageName}:${timing}`);
      if (slot) slot.deferred.resolve();
    }

    const deferred = this.packageDeferreds.get(packageName);
    if (deferred) deferred.reject(new Error(errorMessage));
  }

  public resolvePackage(packageName: string): void {
    this.packageDeferreds.get(packageName)?.resolve();
  }

  public skipHooks(packageName: string, timing: string): void {
    const slot = this.hookSlots.get(`${packageName}:${timing}`);
    if (!slot || slot.activated) return;
    slot.activated = true;
    slot.skipped = true;
    slot.deferred.resolve();
  }

  public start(packageNames: string[]): void {
    for (const name of packageNames) {
      this.packageDeferreds.set(name, createDeferred());
      this.levelGates.set(name, createDeferred());
      this.hookSlots.set(`${name}:pre`, createHookSlot());
      this.hookSlots.set(`${name}:post`, createHookSlot());
    }

    this.rootListr = new Listr(
      packageNames.map(name => {
        const preSlot = this.hookSlots.get(`${name}:pre`)!;
        const postSlot = this.hookSlots.get(`${name}:post`)!;

        return {
          exitOnError: false,
          task: async (_ctx: any, parentTask: any): Promise<Listr> => {
            this.packageTasks.set(name, parentTask);
            await this.levelGates.get(name)!.promise;
            parentTask.title = chalk.cyan(name);

            return parentTask.newListr(
              [
                {
                  async task(_: any, t: any) {
                    preSlot.task = t;
                    await preSlot.deferred.promise;
                    if (preSlot.skipped) t.skip('');
                  },
                  title: chalk.dim('pre-hooks'),
                },
                {
                  task: async (_: any, buildTask: any) => {
                    this.buildSubtasks.set(name, buildTask);
                    await this.packageDeferreds.get(name)!.promise;
                  },
                  title: 'building...',
                },
                {
                  async task(_: any, t: any) {
                    postSlot.task = t;
                    await postSlot.deferred.promise;
                    if (postSlot.skipped) t.skip('');
                  },
                  title: chalk.dim('post-hooks'),
                },
                {
                  enabled: () => this.validationQueued.has(name),
                  task() {/* static marker */},
                  title: chalk.dim('validation queued'),
                },
              ],
              {concurrent: false, exitOnError: false},
            );
          },
          title: chalk.dim(name),
        };
      }),
      {
        concurrent: true,
        exitOnError: false,
        rendererOptions: {
          collapseErrors: false,
          collapseSkips: true,
          collapseSubtasks: true,
        },
      },
    );

    this.rootListr.run().catch(() => {});
  }

  public startHooks(packageName: string, hookNames: string[], timing: string, operation: string): void {
    const slot = this.hookSlots.get(`${packageName}:${timing}`);
    if (!slot || slot.activated) return;
    slot.activated = true;

    const label = hookNames.map(n => chalk.dim(n)).join(chalk.dim(', '));
    if (slot.task) {
      slot.task.title = `running ${timing}-${operation} hooks ${chalk.dim('\u2014')} ${label}`;
    }
  }

  public updateBuildTitle(packageName: string, title: string): void {
    const task = this.buildSubtasks.get(packageName);
    if (task) task.title = title;
  }

  public updatePackageTitle(packageName: string, title: string): void {
    const task = this.packageTasks.get(packageName);
    if (task) task.title = title;
  }
}
