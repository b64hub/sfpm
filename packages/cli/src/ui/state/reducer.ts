import type {AppState, NodeStatus, TreeNode} from './types.js';

type Action = {type: string} & Record<string, unknown>;

export function initialState(): AppState {
  return {phase: 'idle', levels: [], validation: []};
}

// ---- tree helpers ----

function updateNode(root: TreeNode, id: string, patch: {status?: NodeStatus; detail?: string}): TreeNode {
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

function updatePackage(state: AppState, packageName: string, patch: {status?: NodeStatus; detail?: string}): AppState {
  const id = `pkg:${packageName}`;
  return {...state, levels: state.levels.map(l => updateNode(l, id, patch))};
}

function upsertStep(state: AppState, packageName: string, step: string, patch: {status: NodeStatus; detail?: string}): AppState {
  const stepId = `pkg:${packageName}/step:${step}`;
  const exists = state.levels.some(l => nodeExists(l, stepId));
  if (exists) {
    return {...state, levels: state.levels.map(l => updateNode(l, stepId, patch))};
  }
  const newStep: TreeNode = {id: stepId, label: step, ...patch, children: []};
  return {...state, levels: state.levels.map(l => addChildToNode(l, `pkg:${packageName}`, newStep))};
}

function updateValidation(state: AppState, packageName: string, patch: {status?: NodeStatus; detail?: string}): AppState {
  const id = `validate:${packageName}`;
  return {...state, validation: state.validation.map(n => (n.id === id ? {...n, ...patch} : n))};
}

// ---- reducer ----

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'build:start': {
      const levels = action['levels'] as string[][];
      return {
        ...state,
        phase: 'building',
        startedAt: Date.now(),
        levels: levels.map((pkgs, i) => ({
          id: `level:${i}`,
          label: `Level ${i}`,
          status: 'pending' as NodeStatus,
          children: pkgs.map(pkg => ({
            id: `pkg:${pkg}`,
            label: pkg,
            status: 'pending' as NodeStatus,
            children: [],
          })),
        })),
      };
    }

    case 'build:package:status':
      return updatePackage(state, action['packageName'] as string, {
        status: action['status'] as NodeStatus,
        detail: action['detail'] as string | undefined,
      });

    case 'build:package:step':
      return upsertStep(state, action['packageName'] as string, action['step'] as string, {
        status: action['status'] as NodeStatus,
        detail: action['detail'] as string | undefined,
      });

    case 'build:complete':
      return action['success'] ? {...state, phase: 'done'} : state;

    case 'validation:start': {
      const packages = action['packages'] as string[];
      return {
        ...state,
        phase: 'validating',
        validation: packages.map(pkg => ({
          id: `validate:${pkg}`,
          label: pkg,
          status: 'pending' as NodeStatus,
          children: [],
        })),
      };
    }

    case 'validation:status':
      return updateValidation(state, action['packageName'] as string, {
        status: action['status'] as NodeStatus,
        detail: action['detail'] as string | undefined,
      });

    default:
      return state;
  }
}
