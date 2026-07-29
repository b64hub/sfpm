import type {NodeStatus, TreeNode} from './types.js';

/**
 * Derives a parent status from its children.
 * Used by OrchestrationView to determine when a level is fully complete.
 */
export function deriveStatus(children: TreeNode[]): NodeStatus {
  if (children.length === 0) return 'pending';
  if (children.some(c => c.status === 'failed')) return 'failed';
  if (children.some(c => c.status === 'running')) return 'running';
  if (children.some(c => c.status === 'validating')) return 'validating';
  if (children.every(c => c.status === 'success' || c.status === 'skipped')) return 'success';
  return 'pending';
}

export interface PackageCounts {
  failed: number;
  pending: number;
  running: number;
  skipped: number;
  success: number;
  total: number;
  validating: number;
}

export function formatTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
}

/** Aggregates per-package statuses across all levels. */
export function countPackages(levels: TreeNode[]): PackageCounts {
  const counts: PackageCounts = {
    failed: 0, pending: 0, running: 0, skipped: 0, success: 0, total: 0, validating: 0,
  };
  for (const level of levels) {
    for (const pkg of level.children) {
      counts.total++;
      counts[pkg.status]++;
    }
  }

  return counts;
}
