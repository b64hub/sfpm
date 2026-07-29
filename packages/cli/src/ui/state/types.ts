export type NodeStatus = 'failed' | 'pending' | 'running' | 'skipped' | 'success';

export interface TreeNode {
  children: TreeNode[];
  detail?: string;
  /** Set when status transitions to a terminal state. Ms elapsed since startedAt. */
  duration?: number;
  id: string;
  label: string;
  /** Arbitrary key/value metadata set by the build system on completion (e.g. components, hash). */
  meta?: Record<string, string>;
  /** Set when status transitions to 'running'. */
  startedAt?: number;
  status: NodeStatus;
}

export interface AppState {
  levels: TreeNode[];
  phase: 'building' | 'done' | 'idle' | 'validating';
  startedAt?: number;
  validation: TreeNode[];
}
