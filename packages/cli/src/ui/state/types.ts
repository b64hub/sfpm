import type {ErrorDetail} from '@b64hub/sfpm-core';

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
  /** Structured per-item failure breakdown, when the failure has more than one part. */
  errorDetails?: ErrorDetail[];
  id: string;
  label: string;
  /** Arbitrary key/value metadata set by the build system on completion (e.g. components, hash). */
  meta?: Record<string, string>;
  /** Set when status transitions to 'running'. */
  startedAt?: number;
  status: NodeStatus;
  /** Best-effort findings that didn't fail the build (e.g. local validation diagnostics). Additive across pre-build tasks. */
  warnings?: ErrorDetail[];
}

export interface AppState {
  levels: TreeNode[];
  /** Ring-buffered pino log records (last 200), fed by the pino bridge. */
  logs: LogRecord[];
  phase: 'done' | 'failed' | 'idle' | 'running' | 'validating';
  startedAt?: number;
  /**
   * Ordered log of package/step running+terminal transitions, in the order
   * they occurred. Used by OrchestrationView's plain-mode continuous stream —
   * ignored in interactive mode, where everything is deferred to one atomic
   * flush instead. Each entry references a node id; the node itself is
   * looked up live from `levels` at render time.
   */
  streamLog: StreamEntry[];
  validation: TreeNode[];
}

export interface StreamEntry {
  /** Unique per transition, e.g. `${nodeId}:${status}` — a node appears twice (running, then terminal). */
  id: string;
  nodeId: string;
}

export {type ErrorDetail} from '@b64hub/sfpm-core';
