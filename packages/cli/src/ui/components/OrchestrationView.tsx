import type {ReactNode} from 'react';

import {Box, Static, Text} from 'ink';
import {useStdout} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus} from '../state/selectors.js';
import {toRowProps} from '../state/adapters.js';
import {rawSym} from '../renderer-utils.js';
import {Divider} from './base/Divider.js';
import {COL_TRAILING, PackageRow} from './PackageRow.js';
import {ValidationView} from './ValidationView.js';

// ---- types ------------------------------------------------------------------

export interface OrchestrationViewProps {
  levels: TreeNode[];
  /** Validation-phase nodes. Rendered below the build area when present. */
  validation?: TreeNode[];
  /** Show the validation section. Defaults to true when `validation` is non-empty. */
  showValidation?: boolean;
  /**
   * Builds the columns slot for each row. Use `PackageRow.MetaCols`.
   * Omit to show time only.
   */
  getColumns?: (node: TreeNode) => ReactNode;
  /**
   * Header for the columns slot. Pass `<PackageRow.MetaCols cols={...} header />`
   * using the same spec as `getColumns`.
   */
  headerColumns?: ReactNode;
}

// ---- constants --------------------------------------------------------------

const TERMINAL = new Set(['failed', 'skipped', 'success']);

/**
 * Groups with more than this many packages are collapsed into a single rollup
 * line. Keeps the live area focused on what's actively happening.
 */
const ROLLUP_AT = 3;

// ---- static item discriminated union ----------------------------------------

/**
 * Static renders items exactly once, in array order, permanently above the
 * live area. Putting the header as item 0 ensures it always appears before
 * completed packages — you can't achieve this with two separate Static
 * components because Ink has no ordering guarantee between them.
 */
type StaticItem =
  | {kind: 'header'; totalLevels: number; totalPackages: number}
  | {kind: 'pkg';    node: TreeNode};

// ---- sub-components ---------------------------------------------------------

interface StatusRollupProps {
  color?: string;
  icon: string;
  label: string;
  pkgs: TreeNode[];
}

/**
 * Compressed summary line for a group of packages that don't need individual
 * rows in the live area (e.g. "✓ 5 packages done — core-utils, shared-types…").
 */
function StatusRollup({color, icon, label, pkgs}: StatusRollupProps) {
  const names = pkgs.map(p => p.label).join(', ');
  const count = pkgs.length;
  return (
    <Box gap={1} marginLeft={2}>
      <Text color={color}>{icon}</Text>
      <Text dimColor>
        {count} {count === 1 ? 'package' : 'packages'} {label}{' \u2014 '}{names}
      </Text>
    </Box>
  );
}

// ---- component --------------------------------------------------------------

export function OrchestrationView({
  getColumns,
  headerColumns,
  levels,
  showValidation = true,
  validation,
}: OrchestrationViewProps) {
  const {stdout} = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const totalPackages = levels.reduce((n, l) => n + l.children.length, 0);
  const allPkgs = levels.flatMap(l => l.children);

  // Deferred atomic flush: nothing goes to <Static> until every package is
  // terminal. Guarantees scrollback shows packages in level order regardless
  // of when async validation resolves for different levels.
  const allTerminal = levels.length > 0 && levels.every(l => TERMINAL.has(deriveStatus(l.children)));
  const donePackages = allTerminal ? allPkgs : [];

  const rowProps = (node: TreeNode) => toRowProps(node, getColumns);

  const staticItems: StaticItem[] = [
    {kind: 'header', totalLevels: levels.length, totalPackages},
    ...donePackages.map((node): StaticItem => ({kind: 'pkg', node})),
  ];

  // Live area groups — all empty when allTerminal (Static has taken over, no duplication).
  // Order: done (history) → validating (async in-flight) → running (active) → failed (errors) → pending (future).
  const failed    = allTerminal ? [] : allPkgs.filter(p => p.status === 'failed');
  const validating = allTerminal ? [] : allPkgs.filter(p => p.status === 'validating');
  const running   = allTerminal ? [] : allPkgs.filter(p => p.status === 'running');
  const done      = allTerminal ? [] : allPkgs.filter(p => p.status === 'success' || p.status === 'skipped');
  const pending   = allTerminal ? [] : allPkgs.filter(p => p.status === 'pending');

  return (
    <Box flexDirection="column">
      {/* Completed packages — flushed atomically in level order when allTerminal */}
      <Static items={staticItems}>
        {item => {
          if (item.kind === 'header') {
            return (
              <Box key="__header__" flexDirection="column" marginTop={2} width={termWidth}>
                <Box justifyContent="space-between">
                  <Text dimColor>{item.totalPackages} packages · {item.totalLevels} levels</Text>
                  <Box flexShrink={0} gap={1}>
                    {headerColumns}
                    <Box width={COL_TRAILING}><Text dimColor>time</Text></Box>
                  </Box>
                </Box>
                <Divider />
              </Box>
            );
          }
          return <PackageRow key={item.node.id} props={rowProps(item.node)} width={termWidth} />;
        }}
      </Static>

      {/* Live area ─────────────────────────────────────────────────────────── */}

      {/* done: roll up when many, otherwise show full rows */}
      {done.length > ROLLUP_AT
        ? <StatusRollup color="green" icon={rawSym.success} label="done" pkgs={done} />
        : done.map(p => <PackageRow key={p.id} props={rowProps(p)} width={termWidth} />)}

      {/* validating: always full rows (spinner active) */}
      {validating.map(p => <PackageRow key={p.id} props={rowProps(p)} width={termWidth} />)}

      {/* running: always full rows */}
      {running.map(p => <PackageRow key={p.id} props={rowProps(p)} width={termWidth} />)}

      {/* failed: always full rows */}
      {failed.map(p => <PackageRow key={p.id} props={rowProps(p)} width={termWidth} />)}

      {/* pending: roll up when many, otherwise show full rows */}
      {pending.length > ROLLUP_AT
        ? <StatusRollup icon={rawSym.pending} label="waiting" pkgs={pending} />
        : pending.map(p => <PackageRow key={p.id} props={rowProps(p)} width={termWidth} />)}

      {/* Validation sidebar (separate post-build phase) */}
      {showValidation && validation && validation.length > 0 && (
        <ValidationView nodes={validation} />
      )}
    </Box>
  );
}
