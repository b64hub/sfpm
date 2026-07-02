import chalk from 'chalk';
import {Listr} from 'listr2';

import {rawSym} from './renderer-utils.js';

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
 * Manages a level-grouped Listr layout for build/install orchestration.
 *
 * The root Listr is **sequential** (one level at a time). Each level
 * contains a **concurrent** sub-Listr with one task per package.
 * Tasks in future levels stay in listr2's native `WAITING` state
 * (no spinner) until the previous level completes.
 *
 * Per-package layout:
 * ```
 * ├── @scope/name
 * │   ├── ✔ pre-build hooks (2) (528ms)       or → [SKIPPED]
 * │   ├── ⠋ staging (42 components)...         rolling build title
 * │   ├── ✔ post-build hooks (1) (320ms)       or → [SKIPPED]
 * │   └── ◼ validation queued                  optional
 * ```
 */
export class OrchestrationListrManager {
  private buildSubtasks = new Map<string, any>();
  private hookSlots = new Map<string, HookSlot>();
  private levelGates = new Map<number, Deferred>();
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

  public onLevelStart(level: number, packages: string[]): void {
    // Initialize per-package state for this level's packages
    for (const name of packages) {
      this.packageDeferreds.set(name, createDeferred());
      this.hookSlots.set(`${name}:pre`, createHookSlot());
      this.hookSlots.set(`${name}:post`, createHookSlot());
    }

    this.levelGates.get(level)?.resolve();
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

  /**
   * Build and run the Listr tree.
   *
   * @param levels - ordered array of levels, each containing its package names.
   *   Derived from the orchestration plan so the full tree is known upfront.
   */
  public start(levels: string[][]): void {
    // Pre-create a gate for every level so onLevelStart can resolve them.
    for (let i = 0; i < levels.length; i++) {
      this.levelGates.set(i, createDeferred());
    }

    this.rootListr = new Listr(
      levels.map((packageNames, levelIndex) => ({
        exitOnError: false,
        task: async (_ctx: any, levelTask: any): Promise<Listr> => {
          // Wait for the orchestrator to signal this level is ready
          await this.levelGates.get(levelIndex)!.promise;

          return levelTask.newListr(
            packageNames.map(name => this.createPackageTask(name)),
            {concurrent: true, exitOnError: false},
          );
        },
        title: chalk.dim(`level ${levelIndex} — ${packageNames.length} ${packageNames.length === 1 ? 'package' : 'packages'}`),
      })),
      {
        concurrent: false,
        exitOnError: false,
        rendererOptions: {
          clearOutput: true,
          collapseErrors: false,
          collapseSkips: true,
          collapseSubtasks: true,
          icon: {
            SKIPPED_WITH_COLLAPSE: rawSym.skip,
          },
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

  // ==========================================================================
  // Internal
  // ==========================================================================

  private createPackageTask(name: string) {
    return {
      exitOnError: false,
      task: async (_ctx: any, parentTask: any): Promise<Listr> => {
        this.packageTasks.set(name, parentTask);
        parentTask.title = chalk.cyan(name);

        const preSlot = this.hookSlots.get(`${name}:pre`)!;
        const postSlot = this.hookSlots.get(`${name}:post`)!;

        return parentTask.newListr(
          [
            {
              async task(_: any, t: any) {
                preSlot.task = t;
                await preSlot.deferred.promise;
                if (preSlot.skipped) t.skip(chalk.dim('pre-hooks - skipped'));
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
                if (postSlot.skipped) t.skip(chalk.dim('post-hooks - skipped'));
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
  }
}
