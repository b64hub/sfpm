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
 * The caller (e.g. OrchestrationView) is responsible for mapping domain data
 * (TreeNode, NodeStatus, timing) into these three display slots:
 *   icon      — pre-constructed ReactNode (StatusIcon, plain char, anything)
 *   primary   — main label (left side)
 *   secondary — dim inline hint (middle)
 *   trailing  — right-side content; ReactNode so it can include animated elements
 *
 * Collapse is a prop, not internal state. If undefined, steps are hidden.
 * When interactive toggle lands, add `onToggle?: () => void` here and manage
 * a `collapsedIds: Set<string>` in AppState — the row stays pure either way.
 */
export interface PackageRowProps {
  id: string;
  icon: ReactNode;
  primary: string;
  secondary?: string;
  trailing?: ReactNode;
  steps?: RowStep[];
  expanded?: boolean;
  indent?: number;
}

// ---- utilities (generic, domain-free) ----

export const COL_META = 9;
export const COL_TIME   = 6;

/**
 * Animates elapsed time since `startedAt`. Re-renders every second via
 * ink's shared animation timer. Import this from OrchestrationView to
 * build the `trailing` prop for running packages.
 */
export function LiveTime({startedAt, format}: {startedAt: number; format: (ms: number) => string}) {
  useAnimation({interval: 1000});
  return <Text color="yellow">{format(Date.now() - startedAt)}</Text>;
}

export interface RowTrailingProps {
  /** Optional context-specific metadata (e.g. "42 built", "87% cov"). Omit to hide the slot. */
  meta?: string;
  duration?: number;
  startedAt?: number;
}

export function RowTrailing({meta, duration, startedAt}: RowTrailingProps) {
  const timeNode: ReactNode = (() => {
    if (duration !== undefined) return <Text dimColor>{formatTime(duration)}</Text>;
    if (startedAt !== undefined) return <LiveTime startedAt={startedAt} format={formatTime} />;
    return <Text dimColor>—</Text>;
  })();

  return (
    <Box gap={1}>
      {meta !== undefined && <Box width={COL_META}><Text dimColor>{meta}</Text></Box>}
      <Box width={COL_TIME}>{timeNode}</Box>
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

// ---- PackageRow ----

/**
 * @param width - Outer row width in columns. Pass `stdout.columns` from the
 *   parent so the row spans the terminal even inside `<Static>` (where
 *   `flexGrow` has no container width to expand into).
 */
export function PackageRow({props, width = 80}: {props: PackageRowProps; width?: number}) {
  return (
    <Box flexDirection="column">
      <Box width={width} justifyContent="space-between">
        {/* Left side: icon + primary + secondary */}
        <Box gap={1} flexShrink={1} minWidth={0} marginLeft={props.indent ? props.indent : 0}>
          {props.icon}
          <Text wrap="truncate">{props.primary}</Text>
          {props.secondary && <Text dimColor wrap="truncate">{props.secondary}</Text>}
        </Box>
        {/* Right side: trailing (status + time, or anything else) */}
        {props.trailing && <Box flexShrink={0}>{props.trailing}</Box>}
      </Box>

      {/* Step children — shown only when expanded */}
      {props.expanded && props.steps?.map(step => (
        <StepRow key={step.id} step={step} />
      ))}
    </Box>
  );
}
