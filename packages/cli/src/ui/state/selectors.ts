import type {NodeStatus, TreeNode} from './types.js';

// ---- PackageRow view model ----

export interface StepProps {
  detail?: string;
  id: string;
  isLast: boolean;
  name: string;
  status: NodeStatus;
}

export interface PackageRowProps {
  /** If true, children are hidden regardless of status. Undefined = auto (status-driven). */
  collapsed?: boolean;
  /** Inline dim hint shown on the main row. */
  detail?: string;
  duration?: number;
  id: string;
  name: string;
  startedAt?: number;
  status: NodeStatus;
  steps: StepProps[];
}

/**
 * Whether a package row should be expanded (show step children).
 * Running and failed are auto-expanded; everything else is collapsed.
 * A caller-supplied `collapsed` prop overrides the automatic behaviour.
 */
export function isExpanded(props: Pick<PackageRowProps, 'collapsed' | 'status'>): boolean {
  if (props.collapsed !== undefined) return !props.collapsed;
  return props.status === 'running' || props.status === 'failed';
}

/** Maps a TreeNode into the agnostic PackageRowProps the component expects. */
export function toPackageRowProps(node: TreeNode): PackageRowProps {
  const runningSteps = node.children.filter(c => c.status === 'running');
  const runningStep  = runningSteps.at(-1);

  // For running packages: inline hint = latest running step label (or node.detail)
  // For others: just node.detail
  const detail
    = node.status === 'running'
      ? (runningStep?.label ?? node.detail)
      : node.detail;

  const steps: StepProps[] = node.children.map((c, i) => ({
    detail: c.detail,
    id: c.id,
    isLast: i === node.children.length - 1,
    name: c.label,
    status: c.status,
  }));

  return {
    detail,
    duration: node.duration,
    id: node.id,
    name: node.label,
    startedAt: node.startedAt,
    status: node.status,
    steps,
  };
}

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

export function formatTime(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`;
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
