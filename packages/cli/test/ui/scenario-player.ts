import type {AppState, TreeNode} from '../../src/ui/state/types.js';

import {initialState, reducer} from '../../src/ui/state/reducer.js';
import {deriveStatus} from '../../src/ui/state/selectors.js';

type Action = Record<string, unknown> & {type: string};

const TERMINAL = new Set(['failed', 'skipped', 'success']);

/**
 * Pure-function test harness for the App reducer.
 *
 * Drives a sequence of events through the reducer and exposes
 * inspection helpers so test assertions stay readable.
 */
export class ScenarioPlayer {
  private state: AppState;

  constructor() {
    this.state = initialState();
  }

  /**
   * Whether every package across every level is terminal.
   * Mirrors OrchestrationView's allTerminal — when true the deferred static
   * flush fires and packages appear in level order.
   */
  allTerminal(): boolean {
    return (
      this.state.levels.length > 0
      && this.state.levels.every(l => TERMINAL.has(deriveStatus(l.children)))
    );
  }

  /**
   * Index of the currently-building level in the original levels array.
   * Mirrors OrchestrationView's currentBuildLevelIdx computation.
   */
  currentBuildLevelIdx(): number {
    return this.state.levels.findIndex(l => l.children.some(p => p.status === 'running' || p.status === 'failed'));
  }

  /** Current state. */
  currentState(): AppState {
    return this.state;
  }

  /** Find a package node by label, searching all levels. */
  pkg(label: string): TreeNode | undefined {
    for (const level of this.state.levels) {
      const found = level.children.find(p => p.label === label);
      if (found) return found;
    }

    return undefined;
  }

  /** Apply a batch of events sequentially. */
  play(events: Action[]): this {
    for (const event of events) {
      this.state = reducer(this.state, event);
    }

    return this;
  }

  /**
   * Non-pending packages from all levels before the current build level.
   * Mirrors OrchestrationView's priorActivePkgs computation.
   */
  priorActivePkgs(): TreeNode[] {
    const idx = this.currentBuildLevelIdx();
    if (idx <= 0) return [];
    return this.state.levels.slice(0, idx).flatMap(l => l.children.filter(p => p.status !== 'pending'));
  }

  /** Apply a single event and return the resulting state. */
  step(event: Action): AppState {
    this.state = reducer(this.state, event);
    return this.state;
  }

  /** Find a step node under a package. */
  stepOf(pkgLabel: string, stepLabel: string): TreeNode | undefined {
    return this.pkg(pkgLabel)?.children.find(s => s.label === stepLabel);
  }
}
