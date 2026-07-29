export type NodeStatus = 'failed' | 'pending' | 'running' | 'skipped' | 'success' | 'validating';

/** A single pino log record forwarded through the pino bridge. */
export interface LogRecord {
  [key: string]: unknown;
  level: number;
  msg: string;
  time?: number;
}

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
  /** Ring-buffered pino log records (last 200), fed by the pino bridge. */
  logs: LogRecord[];
  phase: 'done' | 'idle' | 'running' | 'validating';
  startedAt?: number;
  validation: TreeNode[];
}
