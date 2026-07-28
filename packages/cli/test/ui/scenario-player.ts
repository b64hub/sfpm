import {initialState, reducer} from '../../src/ui/state/reducer.js';
import type {AppState} from '../../src/ui/state/types.js';

type Action = {type: string} & Record<string, unknown>;

export class ScenarioPlayer {
  private state: AppState;

  constructor() {
    this.state = initialState();
  }

  play(events: Action[]): this {
    for (const event of events) {
      this.state = reducer(this.state, event);
    }
    return this;
  }

  currentState(): AppState {
    return this.state;
  }
}
