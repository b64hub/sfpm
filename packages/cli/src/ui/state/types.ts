export type NodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface TreeNode {
  id: string;
  label: string;
  status: NodeStatus;
  detail?: string;
  children: TreeNode[];
}

export interface AppState {
  phase: 'idle' | 'building' | 'validating' | 'done';
  levels: TreeNode[];
  validation: TreeNode[];
  startedAt?: number;
}
