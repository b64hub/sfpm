import type {ReactNode} from 'react';
import {Box, Text} from 'ink';

import {formatTime} from '../state/selectors.js';
import { ElapsedTime } from './base/ElapsedTime.js';

// ---- types ----

export interface RowStep {
  id: string;
  /** Pre-rendered icon character (caller supplies from rawSym or similar). */
  icon: string;
  primary: string;
  secondary?: string;
  isLast: boolean;
}

/**
 * Agnostic row interface — no domain types.
 *
 * The caller (e.g. adapters.tsx) is responsible for mapping domain data into
 * these display slots. Each slot is a ReactNode so callers compose sub-components:
 *
 *   icon      — pre-constructed ReactNode (StatusIcon, plain char, anything)
 *   primary   — main label string
 *   secondary — dim inline hint; use PackageRow.Secondary for the default style
 *   error     — terminal failure detail; replaces secondary and suppresses steps
 *   trailing  — right-side content; use PackageRow.Trailing for the default (meta + time)
 *
 * Collapse is a prop, not internal state. If steps/expanded are undefined, steps are hidden.
 */
export interface PackageRowProps {
  id: string;
  icon: ReactNode;
  primary: string;
  secondary?: ReactNode;
  /**
   * Terminal failure detail. When set, it is shown in place of `secondary`
   * and step children are suppressed entirely — a failed package's own
   * message is the whole story; per-step status may be incomplete or stale
   * (a step whose own completion event only fires on success never reaches
   * a terminal state on its own).
   */
  error?: ReactNode;
  /**
   * Structured breakdown of `error`, one line per item (e.g. one failing
   * deploy component). Rendered below the header row, capped at
   * {@link ERROR_LINES_MAX} lines with a "+N more" trailer — the full list
   * always still reaches the run log regardless of what's capped here.
   */
  errorLines?: string[];
  /** Fixed-width metadata columns, right of secondary. Use PackageRow.MetaCols. */
  columns?: ReactNode;
  /** Rightmost slot — time only. Use PackageRow.Trailing. */
  trailing?: ReactNode;
  steps?: RowStep[];
  expanded?: boolean;
  indent?: number;
}

// ---- sub-components ----

export const COL_META = 9;
export const COL_TRAILING = 6;

/**
 * Cap on how many `errorLines` render inline. Mirrors OrchestrationView's
 * `ROLLUP_AT` — same problem (an unbounded list would spam the live area
 * and the final scrollback), same fix (show a bounded sample + a count).
 */
const ERROR_LINES_MAX = 5;

/** Default secondary slot: dim truncating text. */
function Secondary({children}: {children: ReactNode}) {
  return <Text dimColor wrap="truncate">{children}</Text>;
}

/** Rightmost trailing slot: time only. */
export interface RowTrailingProps {
  duration?: number;
  startedAt?: number;
}

function Trailing({duration, startedAt}: RowTrailingProps) {
  const timeNode: ReactNode = (() => {
    if (duration !== undefined) return <Text dimColor>{formatTime(duration)}</Text>;
    if (startedAt !== undefined) return <ElapsedTime startedAt={startedAt} format={formatTime} color="yellow" />;
    return <Text dimColor>—</Text>;
  })();

  return <Box width={COL_TRAILING}>{timeNode}</Box>;
}

// Keep the standalone export for callers that import RowTrailing by name.
export { Trailing as RowTrailing };

// ---- MetaCols ----

/** Spec for one fixed-width metadata column in MetaCols. */
export interface MetaColSpec {
  key: string;
  /** Fixed column width in characters. */
  width: number;
  /** Header label (defaults to key). */
  label?: string;
}

export interface MetaColsProps {
  cols: MetaColSpec[];
  meta?: Record<string, string>;
  /** Render as header row: shows column labels instead of values. */
  header?: boolean;
}

/**
 * Fixed-width metadata columns. Slots into PackageRowProps.columns.
 * Use the same `cols` spec for both rows and the header.
 * Missing keys render —. Time is handled separately by PackageRow.Trailing.
 */
function MetaCols({cols, meta, header = false}: MetaColsProps) {
  return (
    <Box gap={1}>
      {cols.map(col => (
        <Box key={col.key} width={col.width}>
          <Text dimColor>{header ? (col.label ?? col.key) : (meta?.[col.key] ?? '—')}</Text>
        </Box>
      ))}
    </Box>
  );
}

// ---- step row ----

function StepRow({step}: {step: RowStep}) {
  return (
    <Box marginLeft={3} gap={1}>
      <Text dimColor>{step.isLast ? '╰' : '├'}</Text>
      <Text dimColor>{step.icon}</Text>
      <Text dimColor>{step.primary}</Text>
      {step.secondary && <Text dimColor>{step.secondary}</Text>}
    </Box>
  );
}

// ---- error detail lines ----

export function ErrorLines({lines}: {lines: string[]}) {
  const shown = lines.slice(0, ERROR_LINES_MAX);
  const remaining = lines.length - shown.length;
  return (
    <Box flexDirection="column" marginLeft={3}>
      {shown.map((line, i) => (
        <Text key={i} dimColor wrap="truncate">{line}</Text>
      ))}
      {remaining > 0 && (
        <Text dimColor>+{remaining} more — see full logs</Text>
      )}
    </Box>
  );
}

// ---- PackageRow ----

/**
 * @param width - Outer row width in columns. Pass `stdout.columns` from the
 *   parent so the row spans the terminal even inside `<Static>` (where
 *   `flexGrow` has no container width to expand into).
 */
function PackageRowFn({props, width = 80}: {props: PackageRowProps; width?: number}) {
  return (
    <Box flexDirection="column">
      <Box width={width} justifyContent="space-between">
        {/* Left side: icon + primary + (error, if set, else secondary) */}
        <Box gap={1} flexShrink={1} minWidth={0} marginLeft={props.indent ?? 0}>
          {props.icon}
          <Text wrap="truncate">{props.primary}</Text>
          {props.error ?? props.secondary}
        </Box>
        {/* Right side: columns + trailing, always together */}
        <Box flexShrink={0} gap={1}>
          {props.columns}
          {props.trailing}
        </Box>
      </Box>

      {/* Step children — shown only when expanded, and never alongside an
          error: a failed package shows only its own message, not per-step
          status. */}
      {!props.error && props.expanded && props.steps?.map(step => (
        <StepRow key={step.id} step={step} />
      ))}

      {/* Structured error breakdown — capped, independent of steps. */}
      {props.errorLines && props.errorLines.length > 0 && (
        <ErrorLines lines={props.errorLines} />
      )}
    </Box>
  );
}

/**
 * PackageRow with composable slot sub-components.
 *
 * @example Explicit composition (via adapters.tsx)
 * ```tsx
 * <PackageRow props={{
 *   id, icon,
 *   primary:   node.label,
 *   secondary: <PackageRow.Secondary>{hint}</PackageRow.Secondary>,
 *   trailing:  <PackageRow.Trailing meta="42 cmp" startedAt={node.startedAt} />,
 * }} />
 * ```
 */
export const PackageRow = Object.assign(PackageRowFn, {
  /** Default secondary slot: dim truncating text. */
  Secondary,
  /** Default trailing slot: single meta label + elapsed/duration time. */
  Trailing,
  /** Multi-column metadata trailing with fixed-width alignment. */
  MetaCols,
  /** Animated elapsed time. Same component as Footer.Elapsed. */
  Elapsed: ElapsedTime,
});
