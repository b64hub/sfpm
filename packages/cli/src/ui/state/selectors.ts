import type {NodeStatus, TreeNode} from './types.js';

/**
 * Derives a parent status from its children — used by LevelRow so we don't
 * need to emit level:status events from the orchestrator.
 */
export function deriveStatus(children: TreeNode[]): NodeStatus {
  if (children.length === 0) return 'pending';
  if (children.some(c => c.status === 'failed')) return 'failed';
  if (children.some(c => c.status === 'running')) return 'running';
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
}

/** Aggregates per-package statuses across all levels. */
export function countPackages(levels: TreeNode[]): PackageCounts {
  const counts: PackageCounts = {
    failed: 0, pending: 0, running: 0, skipped: 0, success: 0, total: 0,
  };
  for (const level of levels) {
    for (const pkg of level.children) {
      counts.total++;
      counts[pkg.status]++;
    }
  }

  return counts;
}
