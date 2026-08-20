// ── State ─────────────────────────────────────────────────────────────────────

export type PoolDeletePhase = 'done' | 'empty' | 'failed' | 'running' | 'warning';

export interface PoolDeleteRow {
  /** Orgs deleted so far (ticks up in real time as they land, fast as it is). */
  completed: number;
  /** Final deleted count — set once the tag's `delete:done` arrives. */
  deleted: number;
  /** Final error messages — set once the tag's `delete:done` arrives. */
  errors: string[];
  phase: PoolDeletePhase;
  startedAt: number;
  tag: string;
  /** Orgs matching the pool's criteria — unknown until the query resolves. */
  total?: number;
}

export interface PoolDeleteState {
  devhubAlias: string;
  phase: 'done' | 'idle' | 'running';
  rows: PoolDeleteRow[];
}

export function initialState(devhubAlias: string): PoolDeleteState {
  return {devhubAlias, phase: 'idle', rows: []};
}

const TERMINAL: Set<PoolDeletePhase> = new Set(['done', 'empty', 'failed', 'warning']);

// ── Reducer ───────────────────────────────────────────────────────────────────

export type Action
  = | {count: number; tag: string; type: 'delete:count';}
    | {deleted: number;  errors: string[]; tag: string; type: 'delete:done';}
    | {tag: string; type: 'delete:org:done';}
    | {tag: string; type: 'delete:start';};

function patchRow(rows: PoolDeleteRow[], tag: string, patch: Partial<PoolDeleteRow>): PoolDeleteRow[] {
  return rows.map(r => r.tag === tag ? {...r, ...patch} : r);
}

export function reducer(state: PoolDeleteState, action: Action): PoolDeleteState {
  switch (action.type) {
  case 'delete:count': {
    return {...state, rows: patchRow(state.rows, action.tag, {total: action.count})};
  }

  case 'delete:done': {
    const {deleted, errors, tag} = action;
    const phase: PoolDeletePhase = deleted === 0 && errors.length === 0
      ? 'empty'
      : errors.length === 0
        ? 'done'
        : deleted > 0
          ? 'warning'
          : 'failed';

    const rows = patchRow(state.rows, tag, {deleted, errors, phase});
    const allDone = rows.length > 0 && rows.every(r => TERMINAL.has(r.phase));
    return {...state, phase: allDone ? 'done' : state.phase, rows};
  }

  case 'delete:org:done': {
    const row = state.rows.find(r => r.tag === action.tag);
    if (!row) return state;
    return {...state, rows: patchRow(state.rows, action.tag, {completed: row.completed + 1})};
  }

  case 'delete:start': {
    return {
      ...state,
      phase: 'running',
      rows: [...state.rows, {
        completed: 0, deleted: 0, errors: [], phase: 'running', startedAt: Date.now(), tag: action.tag,
      }],
    };
  }

  default: {
    return state;
  }
  }
}
