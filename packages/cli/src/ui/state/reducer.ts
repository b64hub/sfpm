import type {
  AppState, LogRecord, NodeStatus, TreeNode,
} from './types.js';

type Action = Record<string, unknown> & {type: string};

type NodePatch = {detail?: string; duration?: number; meta?: Record<string, string>; startedAt?: number; status?: NodeStatus;};

const TERMINAL = new Set<NodeStatus>(['failed', 'skipped', 'success']);

export function initialState(): AppState {
  return {
    levels: [], logs: [], phase: 'idle', validation: [],
  };
}

// ---- tree helpers ----

function updateNode(root: TreeNode, id: string, patch: NodePatch): TreeNode {
  if (root.id === id) return {...root, ...patch};
  const children = root.children.map(c => updateNode(c, id, patch));
  return children === root.children ? root : {...root, children};
}

function addChildToNode(root: TreeNode, parentId: string, child: TreeNode): TreeNode {
  if (root.id === parentId) return {...root, children: [...root.children, child]};
  const children = root.children.map(c => addChildToNode(c, parentId, child));
  return children === root.children ? root : {...root, children};
}

function nodeExists(root: TreeNode, id: string): boolean {
  if (root.id === id) return true;
  return root.children.some(c => nodeExists(c, id));
}

/** Finds a package node directly inside level children (O(packages)). */
function findPkg(levels: AppState['levels'], packageName: string): TreeNode | undefined {
  const id = `pkg:${packageName}`;
  for (const level of levels) {
    const found = level.children.find(p => p.id === id);
    if (found) return found;
  }
}

/**
 * When a package fails, any step still mid-flight (running/pending) never got
 * its own terminal event — e.g. a deploy step whose completion event only
 * fires on success. Left alone it shows a stale checkmark or frozen spinner
 * next to a failed package. Flip it to failed so the tree reflects reality.
 */
function failIncompleteChildren(root: TreeNode, id: string): TreeNode {
  if (root.id === id) {
    if (root.children.length === 0) return root;
    return {
      ...root,
      children: root.children.map(c => (TERMINAL.has(c.status) ? c : {...c, status: 'failed' as NodeStatus})),
    };
  }

  const children = root.children.map(c => failIncompleteChildren(c, id));
  return children === root.children ? root : {...root, children};
}

function updatePackage(state: AppState, packageName: string, status: NodeStatus, detail?: string, meta?: Record<string, string>): AppState {
  const id = `pkg:${packageName}`;
  const existing = findPkg(state.levels, packageName);
  const timingPatch: NodePatch
    = status === 'running'
      ? {startedAt: Date.now()}
      : TERMINAL.has(status) && existing?.startedAt
        ? {duration: Date.now() - existing.startedAt, startedAt: undefined}
        : {};
  return {
    ...state,
    levels: state.levels.map(l => {
      const updated = updateNode(l, id, {
        detail, meta, status, ...timingPatch,
      });
      return status === 'failed' ? failIncompleteChildren(updated, id) : updated;
    }),
  };
}

function upsertStep(state: AppState, packageName: string, step: string, patch: {detail?: string; status: NodeStatus;}): AppState {
  const stepId = `pkg:${packageName}/step:${step}`;
  const exists = state.levels.some(l => nodeExists(l, stepId));
  if (exists) {
    return {...state, levels: state.levels.map(l => updateNode(l, stepId, patch))};
  }

  const newStep: TreeNode = {
    id: stepId, label: step, ...patch, children: [],
  };
  return {...state, levels: state.levels.map(l => addChildToNode(l, `pkg:${packageName}`, newStep))};
}

function updateValidation(state: AppState, packageName: string, patch: {detail?: string; status?: NodeStatus;}): AppState {
  const id = `validate:${packageName}`;
  return {...state, validation: state.validation.map(n => (n.id === id ? {...n, ...patch} : n))};
}

// ---- reducer ----

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
  // ── Orchestration lifecycle ──────────────────────────────────────────────

  case 'log:append': {
    return {...state, logs: [...state.logs.slice(-199), action as unknown as LogRecord]};
  }

  case 'orchestration:complete': {
    return {...state, phase: action.success ? 'done' : 'failed'};
  }

  // ── Per-package status ───────────────────────────────────────────────────

  case 'orchestration:init': {
    const levels = action.levels as string[][];
    return {
      ...state,
      levels: levels.map((pkgs, i) => ({
        children: pkgs.map(pkg => ({
          children: [],
          id: `pkg:${pkg}`,
          label: pkg,
          status: 'pending' as NodeStatus,
        })),
        id: `level:${i}`,
        label: `Level ${i}`,
        status: 'pending' as NodeStatus,
      })),
      phase: 'running',
      startedAt: Date.now(),
    };
  }

  case 'package:complete': {
    return updatePackage(
      state,
      action.packageName as string,
      action.status as NodeStatus,
      action.detail as string | undefined,
      action.meta as Record<string, string> | undefined,
    );
  }

  // ── Per-step within a package ────────────────────────────────────────────

  case 'package:running': {
    return updatePackage(state, action.packageName as string, 'running');
  }

  case 'step:complete': {
    return upsertStep(state, action.packageName as string, action.step as string, {
      detail: action.detail as string | undefined,
      status: action.status as NodeStatus,
    });
  }

  case 'step:start': {
    return upsertStep(state, action.packageName as string, action.step as string, {
      detail: action.detail as string | undefined,
      status: 'running',
    });
  }

  // ── Validation sidebar ───────────────────────────────────────────────────

  case 'step:update': {
    // Rolling label change on a running step — status unchanged.
    const stepId = `pkg:${action.packageName as string}/step:${action.step as string}`;
    return {...state, levels: state.levels.map(l => updateNode(l, stepId, {detail: action.detail as string}))};
  }

  case 'validation:init': {
    const packages = action.packages as string[];
    return {
      ...state,
      phase: 'validating',
      validation: packages.map(pkg => ({
        children: [],
        id: `validate:${pkg}`,
        label: pkg,
        status: 'pending' as NodeStatus,
      })),
    };
  }

  // ── Logs ─────────────────────────────────────────────────────────────────

  case 'validation:update': {
    return updateValidation(state, action.packageName as string, {
      detail: action.detail as string | undefined,
      status: action.status as NodeStatus,
    });
  }

  default: {
    return state;
  }
  }
}
