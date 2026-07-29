import {Box, Static, Text} from 'ink';
import {useStdout} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus} from '../state/selectors.js';
import {toRowProps} from '../state/adapters.js';
import {Divider} from './Divider.js';
import {COL_META, COL_TIME, PackageRow} from './PackageRow.js';
import {ValidationView} from './ValidationView.js';

// ---- types ----

export interface OrchestrationViewProps {
  levels: TreeNode[];
  /** Validation-phase nodes. Rendered below the build area when present. */
  validation?: TreeNode[];
  /** Show the validation section. Defaults to true when `validation` is non-empty. */
  showValidation?: boolean;
  /**
   * Per-node metadata for the trailing column (e.g. "42 built", "87% cov").
   * Omit entirely to hide the metadata column from both header and rows.
   */
  getMeta?: (node: TreeNode) => string | undefined;
  /** Column header label for the metadata slot. Only rendered when `getMeta` is provided. */
  metaLabel?: string;
}

// ---- domain constants ----

const TERMINAL = new Set(['success', 'failed', 'skipped']);

// ---- static item discriminated union ----

/**
 * Static renders items exactly once, in array order, permanently above the
 * live area. Putting the header as item 0 ensures it always appears before
 * completed packages — you can't achieve this with two separate Static
 * components because Ink has no ordering guarantee between them.
 */
type StaticItem =
  | {kind: 'header'; totalPackages: number; totalLevels: number}
  | {kind: 'pkg';    node: TreeNode};

// ---- view constants ----

const QUEUE_VISIBLE = 3;

// ---- component ----

export function OrchestrationView({
  levels,
  validation,
  showValidation = true,
  getMeta,
  metaLabel,
}: OrchestrationViewProps) {
  const {stdout} = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const totalPackages = levels.reduce((n, l) => n + l.children.length, 0);

  const doneLevels   = levels.filter(l => TERMINAL.has(deriveStatus(l.children)));
  const activeLevels = levels.filter(l => !TERMINAL.has(deriveStatus(l.children)));
  const donePackages = doneLevels.flatMap(l => l.children);

  // Helper so getMeta threads through consistently to every row.
  const rowProps = (node: TreeNode) => toRowProps(node, getMeta);

  // Header is always item 0; completed packages append after it.
  // termWidth is captured from the closure when each item is first rendered —
  // correct for the vast majority of cases (terminal resize during a build is
  // an edge case Ink doesn't handle well regardless).
  const staticItems: StaticItem[] = [
    {kind: 'header', totalPackages, totalLevels: levels.length},
    ...donePackages.map((node): StaticItem => ({kind: 'pkg', node})),
  ];

  const currentIdx   = activeLevels.findIndex(l =>
    l.children.some(p => p.status === 'running' || p.status === 'failed'),
  );
  const currentLevel = activeLevels[currentIdx >= 0 ? currentIdx : 0];
  const futureLevels = activeLevels.slice((currentIdx >= 0 ? currentIdx : 0) + 1);

  const currentPkgs   = currentLevel?.children ?? [];
  const busy          = currentPkgs.filter(p => p.status !== 'pending');
  const queued        = currentPkgs.filter(p => p.status === 'pending');
  const visibleQueued = queued.slice(0, QUEUE_VISIBLE);
  const hiddenCount   = queued.length - QUEUE_VISIBLE;
  // Pre-skipped packages aren't waiting — they're already terminal.
  const futureCount   = futureLevels.reduce((n, l) => n + l.children.filter(p => p.status !== 'skipped').length, 0);

  return (
    <Box flexDirection="column">
      {/* Header + completed packages — flushed together in order */}
      <Static items={staticItems}>
        {item => {
          if (item.kind === 'header') {
            return (
              <Box key="__header__" flexDirection="column" width={termWidth} marginTop={2}>
                <Box justifyContent="space-between">
                  <Text dimColor>{item.totalPackages} packages · {item.totalLevels} levels</Text>
                  <Box gap={1}>
                    {getMeta !== undefined && (
                      <Box width={COL_META}><Text dimColor>{metaLabel ?? ''}</Text></Box>
                    )}
                    <Box width={COL_TIME}><Text dimColor>time</Text></Box>
                  </Box>
                </Box>
                <Divider />
              </Box>
            );
          }
          return <PackageRow key={item.node.id} props={rowProps(item.node)} width={termWidth} />;
        }}
      </Static>

      {/* Active packages (dynamic — refreshes every render) */}
      {busy.map(pkg => <PackageRow key={pkg.id} props={rowProps(pkg)} width={termWidth} />)}

      {visibleQueued.map(pkg => <PackageRow key={pkg.id} props={rowProps(pkg)} width={termWidth} />)}
      {hiddenCount > 0 && (
        <Box marginLeft={2}>
          <Text dimColor>⋯ {hiddenCount} more queued</Text>
        </Box>
      )}

      {futureLevels.length > 0 && futureCount > 0 && (
        <Box marginLeft={2} marginTop={1}>
          <Text dimColor>
            {futureLevels.length === 1
              ? `Level ${doneLevels.length + (currentIdx >= 0 ? currentIdx : 0) + 1} — ${futureCount} waiting`
              : `${futureLevels.length} levels — ${futureCount} packages waiting`}
          </Text>
        </Box>
      )}

      {/* Validation — shown below the build area when data is present */}
      {showValidation && validation && validation.length > 0 && (
        <ValidationView nodes={validation} />
      )}
    </Box>
  );
}
