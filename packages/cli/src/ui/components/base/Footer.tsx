import type {ReactNode} from 'react';

import {useStdout} from 'ink';
import {Box, Text} from 'ink';

import type {PackageCounts} from '../../state/selectors.js';

import {rawSym} from '../../renderer-utils.js';
import {ElapsedTime} from '../PackageRow.js';
import { GradientBar } from './GradientBar.js';

// ---- composable column sub-components ----

/** Left column default: running · queued. */
function Active({counts}: {counts: PackageCounts}) {
  return (
    <Box gap={1}>
      {counts.running > 0 && <Text color="yellow">{counts.running} running</Text>}
      {counts.running > 0 && counts.pending > 0 && <Text dimColor>·</Text>}
      {counts.pending > 0 && <Text dimColor>{counts.pending} queued</Text>}
    </Box>
  );
}

/** Middle column default: done / failed / skipped. */
function Results({counts}: {counts: PackageCounts}) {
  return (
    <Box gap={2}>
      <Text color="green">{counts.success} done</Text>
      {counts.failed  > 0 && <Text color="red">{counts.failed} {rawSym.fail}</Text>}
      {counts.skipped > 0 && <Text dimColor>{counts.skipped} skipped</Text>}
    </Box>
  );
}

// ---- types ----

export interface FooterProps {
  /** Pre-computed package counts. Caller is responsible for deriving these. */
  counts: PackageCounts;
  /**
   * Convenience: renders an `ElapsedTime` in the right column when provided.
   * Ignored when `timeSlot` is set.
   */
  startedAt?: number;

  // ---- column visibility (all default true) ----
  /** Left column: running · queued. */
  showActive?: boolean;
  /** Middle column: done / failed / skipped. */
  showResults?: boolean;
  /** Right column: elapsed time. */
  showTime?: boolean;
  /** Progress bar row. Caller decides when to enable (e.g. only during build phase). */
  progressBar?: boolean;

  // ---- slot injection (overrides the corresponding show* + default when provided) ----
  activeSlot?: ReactNode;
  resultsSlot?: ReactNode;
  timeSlot?: ReactNode;
}

const gradient = {
  start: {r: 61, g: 127, b: 255},  // rgb(61, 127, 255)
  end: {r: 255, g: 51, b: 102},  // rgb(255, 51, 102)
}
// ---- component ----

function FooterFn({
  counts,
  startedAt,
  showActive  = true,
  showResults = true,
  showTime    = true,
  progressBar = true,
  activeSlot,
  resultsSlot,
  timeSlot,
}: FooterProps) {
  const {stdout} = useStdout();
  const termWidth = stdout?.columns ?? 80;

  const completed    = counts.success + counts.skipped + counts.failed;
  const progressLabel = `${completed}/${counts.total}`;
  const colWidth      = Math.floor((termWidth - 6) / 3); // 6 = two " │ " separators
  const barValue      = counts.total > 0 ? Math.round((completed / counts.total) * 100) : 0;

  // Slots override show* flags. An empty column (show*=false, no slot) still
  // renders its flexGrow box so the │ separators never shift.
  const leftContent   = activeSlot  ?? (showActive  ? <Active  counts={counts} /> : null);
  const middleContent = resultsSlot ?? (showResults ? <Results counts={counts} /> : null);
  const rightContent  = timeSlot    ?? (showTime && startedAt !== undefined
    ? <ElapsedTime startedAt={startedAt} dimColor />
    : null);

  return (
    <Box
      flexDirection="column"
      marginTop={1}
      marginBottom={1}
      borderStyle="single"
      borderBottom={false}
      borderLeft={false}
      borderRight={false}
      borderDimColor
    >
      {/* ── Info row: three columns; boxes always render to keep │ separators fixed ── */}
      <Box width={termWidth}>
        <Box width={colWidth}>{leftContent}</Box>
        <Text dimColor> │ </Text>
        <Box width={colWidth}>{middleContent}</Box>
        <Text dimColor> │ </Text>
        <Box width={colWidth} justifyContent="flex-end">{rightContent}</Box>
      </Box>

      {/* ── Progress row: bar capped at one column width + n/m label ── */}
      {progressBar && counts.total > 0 && (
        <Box gap={1} marginTop={1}>
          <GradientBar gradient={gradient} value={barValue} width={colWidth} />
          <Text dimColor>{progressLabel}</Text>
        </Box>
      )}
    </Box>
  );
}

/**
 * Footer with composable column sub-components.
 *
 * @example Default usage
 * ```tsx
 * <Footer counts={counts} startedAt={startedAt} progressBar={isBuilding} />
 * ```
 *
 * @example Explicit slot composition
 * ```tsx
 * <Footer counts={counts} progressBar={isBuilding}
 *   activeSlot={<Footer.Active counts={counts} />}
 *   resultsSlot={<Footer.Results counts={counts} />}
 *   timeSlot={startedAt !== undefined ? <Footer.Elapsed startedAt={startedAt} dimColor /> : undefined}
 * />
 * ```
 */
export const Footer = Object.assign(FooterFn, {
  /** Left column: running · queued. */
  Active:  Active,
  /** Middle column: done / failed / skipped. */
  Results: Results,
  /** Animated elapsed time. Re-exported from PackageRow for slot convenience. */
  Elapsed: ElapsedTime,
});
