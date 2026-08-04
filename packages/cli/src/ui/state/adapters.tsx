import type {ReactNode} from 'react';
import {Text} from 'ink';

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
  const isFailed = node.status === 'failed';
  const runningSteps = node.children.filter(c => c.status === 'running');
  const runningStep  = runningSteps[runningSteps.length - 1];
  const hint         =
    node.status === 'running' || node.status === 'validating'
      ? (runningStep?.label ?? node.detail)
      : node.detail;
  const hintNode = hint !== undefined ? <PackageRow.Secondary>{hint}</PackageRow.Secondary> : undefined;

  const steps: RowStep[] = node.children.map((c, i) => ({
    id:        c.id,
    icon:      STEP_ICON[c.status],
    primary:   c.label,
    secondary: c.detail,
    isLast:    i === node.children.length - 1,
  }));

  // Structured breakdown (e.g. one line per failing deploy component).
  // Formatting `${label}: ${message}` into a plain string happens here —
  // the one place that actually needs a string — not upstream.
  const errorLines = isFailed
    ? node.errorDetails?.map(d => `${d.label}: ${d.message}`)
    : undefined;

  // Warnings are additive on top of a successful/skipped status — never
  // shown for a failed package, whose own error is already the whole story.
  const warningCount = !isFailed ? node.warnings?.length : undefined;
  const warningNode = warningCount
    ? <Text color="yellow">{`${rawSym.warn} ${warningCount} warning${warningCount === 1 ? '' : 's'}`}</Text>
    : undefined;
  const warningLines = warningCount
    ? node.warnings?.map(w => `${w.label}: ${w.message}`)
    : undefined;

  return {
    id:        node.id,
    icon:      <StatusIcon status={node.status} />,
    primary:   node.label,
    // A failed package's own message is shown via `error`, which also
    // suppresses step children in PackageRow — not `secondary`.
    secondary: isFailed ? undefined : hintNode,
    error:     isFailed ? hintNode : undefined,
    errorLines,
    warning:   warningNode,
    warningLines,
    columns:   getColumns ? getColumns(node) : undefined,
    trailing:  <PackageRow.Trailing duration={node.duration} startedAt={node.startedAt} />,
    steps,
    expanded:  node.status === 'running' || node.status === 'failed' || node.status === 'validating',
    indent:    2,
  };
}
