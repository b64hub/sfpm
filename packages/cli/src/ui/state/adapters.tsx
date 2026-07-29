import type {ReactNode} from 'react';

import type { TreeNode, NodeStatus } from "./types.js";
import type { PackageRowProps, RowStep } from "../components/PackageRow.js";
import { PackageRow } from "../components/PackageRow.js";
import { StatusIcon } from "../components/base/StatusIcon.js";
import { rawSym } from "../renderer-utils.js";

const STEP_ICON: Record<NodeStatus, string> = {
  failed:    rawSym.fail,
  pending:   rawSym.pending,
  running:   rawSym.progress,
  skipped:   rawSym.skipped,
  success:   rawSym.success,
  validating: rawSym.progress,
};

export function toRowProps(
  node: TreeNode,
  getColumns?: (node: TreeNode) => ReactNode,
): PackageRowProps {
  const runningSteps = node.children.filter(c => c.status === 'running');
  const runningStep  = runningSteps[runningSteps.length - 1];
  const hint         =
    node.status === 'running' || node.status === 'validating'
      ? (runningStep?.label ?? node.detail)
      : node.detail;

  const steps: RowStep[] = node.children.map((c, i) => ({
    id:        c.id,
    icon:      STEP_ICON[c.status],
    primary:   c.label,
    secondary: c.detail,
    isLast:    i === node.children.length - 1,
  }));

  return {
    id:        node.id,
    icon:      <StatusIcon status={node.status} />,
    primary:   node.label,
    secondary: hint !== undefined
      ? <PackageRow.Secondary>{hint}</PackageRow.Secondary>
      : undefined,
    columns:   getColumns ? getColumns(node) : undefined,
    trailing:  <PackageRow.Trailing duration={node.duration} startedAt={node.startedAt} />,
    steps,
    expanded:  node.status === 'running' || node.status === 'failed' || node.status === 'validating',
    indent:    2,
  };
}
