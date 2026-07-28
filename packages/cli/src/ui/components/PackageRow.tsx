import {useAnimation} from 'ink';
import {Box, Text} from 'ink';

import type {PackageRowProps, StepProps} from '../state/selectors.js';

import {formatTime, isExpanded} from '../state/selectors.js';
import {StatusIcon} from './StatusIcon.js';

// ---- column widths (shared with OrchestrationView header) ----
export const COL_STATUS = 9;
export const COL_TIME   = 6;

// ---- status labels ----

const STATUS_LABELS: Record<PackageRowProps['status'], string> = {
  failed:  'failed',
  pending: 'queued',
  running: 'running',
  skipped: 'skipped',
  success: 'done',
};

// ---- time cells ----

function LiveTime({startedAt}: {startedAt: number}) {
  useAnimation({interval: 1000});
  return <Text color="yellow">{formatTime(Date.now() - startedAt)}</Text>;
}

function TimeCell({props}: {props: PackageRowProps}) {
  if (props.duration !== undefined) return <Text dimColor>{formatTime(props.duration)}</Text>;
  if (props.status === 'running' && props.startedAt !== undefined) return <LiveTime startedAt={props.startedAt} />;
  return <Text dimColor>—</Text>;
}

// ---- step row ----

function StepRow({step}: {step: StepProps}) {
  return (
    <Box marginLeft={3} gap={1}>
      <Text dimColor>{step.isLast ? '└' : '├'}</Text>
      <StatusIcon status={step.status} />
      <Text dimColor>{step.name}</Text>
      {step.detail && <Text dimColor>{step.detail}</Text>}
    </Box>
  );
}

// ---- PackageRow ----

/**
 * Pure function of {@link PackageRowProps} — no domain types imported.
 * Mapping from TreeNode → PackageRowProps lives in {@link toPackageRowProps}.
 *
 * Collapse behaviour:
 *   running → expanded (step children + inline running-step hint)
 *   failed  → expanded (step children below with └/├ connectors)
 *   others  → collapsed (children hidden)
 *   Caller can override via the `collapsed` prop.
 */
export function PackageRow({props}: {props: PackageRowProps}) {
  const expanded = isExpanded(props);

  return (
    <Box flexDirection="column">
      {/* Main row */}
      <Box>
        <StatusIcon status={props.status} />
        <Text> </Text>
        <Box flexGrow={1}>
          <Text>{props.name}</Text>
        </Box>
        {props.detail && (
          <Box flexShrink={1} marginRight={1}>
            <Text dimColor>{props.detail}</Text>
          </Box>
        )}
        <Box width={COL_STATUS}><Text dimColor>{STATUS_LABELS[props.status]}</Text></Box>
        <Box width={COL_TIME}><TimeCell props={props} /></Box>
      </Box>

      {/* Expanded step children */}
      {expanded && props.steps.map(step => (
        <StepRow key={step.id} step={step} />
      ))}
    </Box>
  );
}
