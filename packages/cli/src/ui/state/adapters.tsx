import type { TreeNode, NodeStatus } from "./types.js";
import type { PackageRowProps, RowStep } from "../components/PackageRow.js";
import { RowTrailing } from "../components/PackageRow.js";
import { StatusIcon } from "../components/StatusIcon.js";
import { formatTime } from "./selectors.js";
import { rawSym } from "../renderer-utils.js";

const STATUS_LABELS: Record<NodeStatus, string> = {
  failed:  'failed',
  pending: 'queued',
  running: 'running',
  skipped: 'skipped',
  success: 'done',
};

const STEP_ICON: Record<NodeStatus, string> = {
  failed:  rawSym.fail,
  pending: rawSym.pending,
  running: rawSym.progress,
  skipped: rawSym.skipped,
  success: rawSym.success,
};

export function toRowProps(node: TreeNode): PackageRowProps {
  const runningSteps = node.children.filter(c => c.status === 'running');
  const runningStep  = runningSteps[runningSteps.length - 1];
  const secondary    =
    node.status === 'running' ? (runningStep?.label ?? node.detail) : node.detail;

  const steps: RowStep[] = node.children.map((c, i) => ({
    id:        c.id,
    icon:      STEP_ICON[c.status],
    primary:   c.label,
    secondary: c.detail,
    isLast:    i === node.children.length - 1,
  }));

  return {
    id:       node.id,
    icon:     <StatusIcon status={node.status} />,
    primary:  node.label,
    secondary,
    trailing: <RowTrailing statusLabel={STATUS_LABELS[node.status]} duration={node.duration} startedAt={node.startedAt} />,
    steps,
    expanded: node.status === 'running' || node.status === 'failed',
    indent: 2,
  };
}
