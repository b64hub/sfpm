import type {OrgPhase} from '../components/pool/OrgRow.js';

// ── State ─────────────────────────────────────────────────────────────────────

export interface OrgEntry {
  alias: string;
  completedPackages: number;
  currentPackage?: string;
  currentPackageVersion?: string;
  failedPackages: number;
  phase: OrgPhase;
  startedAt: number;
  tag: string;
  totalPackages: number;
  username: string;
}

/** Per-pool bookkeeping — one entry per tag passed to `pool fill`. */
export interface PoolTracker {
  creationFailed: number;
  done: boolean;
  startedAt: number;
  tag: string;
  total: number;
}

export type StaticItem
  = | {id: string; kind: 'header'; tag: string; total: number}
    | {id: string; kind: 'org'; org: OrgEntry};

export interface PoolFillState {
  devhubAlias: string;
  orgs: OrgEntry[];
  phase: 'done' | 'idle' | 'provisioning';
  pools: PoolTracker[];
  /**
   * Append-only, in chronological event order: one header per pool (as each
   * starts) and one row per org (as each finishes). Concurrent pools may
   * interleave their headers/rows, so this is built directly by the reducer
   * rather than derived at render time — <Static> requires items to never
   * change position once flushed.
   */
  staticItems: StaticItem[];
}

export function initialState(devhubAlias: string): PoolFillState {
  return {
    devhubAlias,
    orgs: [],
    phase: 'idle',
    pools: [],
    staticItems: [],
  };
}

export const TERMINAL: Set<OrgPhase> = new Set(['done', 'failed', 'warning']);

// ── Reducer ───────────────────────────────────────────────────────────────────

export type Action
  = | {alias: string;       tag: string; type: 'org:appeared'; username: string}
    | {packageName: string;       success: boolean; type: 'org:pkg:done'; username: string; version?: string}
    | {packageName: string;      total: number; type: 'org:pkg:start'; username: string}
    | {tag: string;         total: number; type: 'pool:start';}
    | {tag: string; type: 'pool:creation:failed';}
    | {tag: string;          type: 'pool:done';}
    | {type: 'org:deploying';      username: string}
    | {type: 'org:done';           username: string}
    | {type: 'org:failed';         username: string}
    | {type: 'org:prereqs';        username: string};

function patchOrg(orgs: OrgEntry[], username: string, patch: Partial<OrgEntry>): OrgEntry[] {
  return orgs.map(o => o.username === username ? {...o, ...patch} : o);
}

export function reducer(state: PoolFillState, action: Action): PoolFillState {
  switch (action.type) {
  case 'org:appeared': {
    return {
      ...state,
      orgs: [...state.orgs, {
        alias: action.alias,
        completedPackages: 0,
        failedPackages: 0,
        phase: 'creating',
        startedAt: Date.now(),
        tag: action.tag,
        totalPackages: 0,
        username: action.username,
      }],
    };
  }

  case 'org:deploying': {
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'deploying'})};
  }

  case 'org:done': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org || TERMINAL.has(org.phase)) return state;
    const phase: OrgPhase = org.failedPackages > 0 ? 'warning' : 'done';
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {phase}),
      staticItems: [...state.staticItems, {id: action.username, kind: 'org', org: {...org, phase}}],
    };
  }

  case 'org:failed': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org || TERMINAL.has(org.phase)) return state;
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {phase: 'failed'}),
      staticItems: [...state.staticItems, {id: action.username, kind: 'org', org: {...org, phase: 'failed'}}],
    };
  }

  case 'org:pkg:done': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org) return state;
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {
        completedPackages: org.completedPackages + 1,
        currentPackageVersion: action.version,
        failedPackages: org.failedPackages + (action.success ? 0 : 1),
      }),
    };
  }

  case 'org:pkg:start': {
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {
        currentPackage: action.packageName,
        currentPackageVersion: undefined,
        totalPackages: action.total,
      }),
    };
  }

  case 'org:prereqs': {
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'prereqs'})};
  }

  case 'pool:creation:failed': {
    return {
      ...state,
      pools: state.pools.map(p => p.tag === action.tag ? {...p, creationFailed: p.creationFailed + 1} : p),
    };
  }

  case 'pool:done': {
    const pools = state.pools.map(p => p.tag === action.tag ? {...p, done: true} : p);
    const allDone = pools.length > 0 && pools.every(p => p.done);
    return {...state, phase: allDone ? 'done' : state.phase, pools};
  }

  case 'pool:start': {
    return {
      ...state,
      phase: 'provisioning',
      pools: [...state.pools, {
        creationFailed: 0, done: false, startedAt: Date.now(), tag: action.tag, total: action.total,
      }],
      staticItems: [...state.staticItems, {
        id: `header:${action.tag}`, kind: 'header', tag: action.tag, total: action.total,
      }],
    };
  }

  default: {
    return state;
  }
  }
}
