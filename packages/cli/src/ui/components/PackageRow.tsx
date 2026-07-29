import type {ReactNode} from 'react';

import {useAnimation} from 'ink';
import {Box, Text} from 'ink';

import {formatTime} from '../state/selectors.js';

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
 *   trailing  — right-side content; use PackageRow.Trailing for the default (meta + time)
 *
 * Collapse is a prop, not internal state. If steps/expanded are undefined, steps are hidden.
 */
export interface PackageRowProps {
  id: string;
  icon: ReactNode;
  primary: string;
  secondary?: ReactNode;
  trailing?: ReactNode;
  steps?: RowStep[];
  expanded?: boolean;
  indent?: number;
}

// ---- ElapsedTime ----

/**
 * Animated elapsed-time display. Re-renders every second.
 *
 * @param format   - Defaults to m:ss. Pass `formatTime` from selectors for the
 *                   package-row style ("1.5s" / "2m 30s").
 * @param color    - Ink color string (e.g. "yellow").
 * @param dimColor - Render dimmed (e.g. for the footer's total elapsed).
 */
export function ElapsedTime({
  startedAt,
  format = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  },
  color,
  dimColor,
}: {
  startedAt: number;
  format?: (ms: number) => string;
  color?: string;
  dimColor?: boolean;
}) {
  useAnimation({interval: 1000});
  return <Text color={color} dimColor={dimColor}>{format(Date.now() - startedAt)}</Text>;
}

// ---- sub-components ----

export const COL_META = 9;
export const COL_TIME = 6;

/** Default secondary slot: dim truncating text. */
function Secondary({children}: {children: ReactNode}) {
  return <Text dimColor wrap="truncate">{children}</Text>;
}

/** Default trailing slot: optional metadata label + elapsed/duration time. */
export interface RowTrailingProps {
  /** Optional context-specific metadata (e.g. "42 built", "87% cov"). Omit to hide the slot. */
  meta?: string;
  duration?: number;
  startedAt?: number;
}

function Trailing({meta, duration, startedAt}: RowTrailingProps) {
  const timeNode: ReactNode = (() => {
    if (duration !== undefined) return <Text dimColor>{formatTime(duration)}</Text>;
    if (startedAt !== undefined) return <ElapsedTime startedAt={startedAt} format={formatTime} color="yellow" />;
    return <Text dimColor>—</Text>;
  })();

  return (
    <Box gap={1}>
      {meta !== undefined && <Box width={COL_META}><Text dimColor>{meta}</Text></Box>}
      <Box width={COL_TIME}>{timeNode}</Box>
    </Box>
  );
}

// Keep the standalone export for callers that import RowTrailing by name.
export { Trailing as RowTrailing };

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
        {/* Left side: icon + primary + secondary */}
        <Box gap={1} flexShrink={1} minWidth={0} marginLeft={props.indent ?? 0}>
          {props.icon}
          <Text wrap="truncate">{props.primary}</Text>
          {props.secondary}
        </Box>
        {/* Right side: trailing (meta + time, or anything else) */}
        {props.trailing && <Box flexShrink={0}>{props.trailing}</Box>}
      </Box>

      {/* Step children — shown only when expanded */}
      {props.expanded && props.steps?.map(step => (
        <StepRow key={step.id} step={step} />
      ))}
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
  /** Default trailing slot: meta label + elapsed/duration time. */
  Trailing,
  /** Animated elapsed time. Same component as Footer.Elapsed. */
  Elapsed: ElapsedTime,
});
