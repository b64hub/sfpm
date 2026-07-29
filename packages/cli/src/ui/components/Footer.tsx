import type {ReactNode} from 'react';

import {useStdout} from 'ink';
import {Box, Text} from 'ink';

import type {PackageCounts} from '../state/selectors.js';

import {rawSym} from '../renderer-utils.js';
import {ElapsedTime} from './PackageRow.js';

// ---- gradient progress bar ----

/** Blue (#0000ff) → Red (#ff0000) gradient at half character height (▄). */
function GradientBar({value, width}: {value: number; width: number}) {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width);
  return (
    <Box>
      {Array.from({length: width}, (_, i) => {
        if (i >= filled) return <Text key={i} dimColor>░</Text>;
        const t = width > 1 ? i / (width - 1) : 1;
        const r = Math.round(t * 255).toString(16).padStart(2, '0');
        const b = Math.round((1 - t) * 255).toString(16).padStart(2, '0');
        return <Text key={i} color={`#${r}00${b}`}>█</Text>;
      })}
    </Box>
  );
}

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

  const completed = counts.success + counts.skipped + counts.failed;
  const nmLabel   = `${completed}/${counts.total}`;
  const barWidth  = Math.max(4, termWidth - nmLabel.length - 1);
  const barValue  = counts.total > 0 ? Math.round((completed / counts.total) * 100) : 0;

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
        <Box flexGrow={1}>{leftContent}</Box>
        <Text dimColor> │ </Text>
        <Box flexGrow={1} justifyContent="center">{middleContent}</Box>
        <Text dimColor> │ </Text>
        <Box flexGrow={1} justifyContent="flex-end">{rightContent}</Box>
      </Box>

      {/* ── Progress row: gradient bar + n/m count ── */}
      {progressBar && counts.total > 0 && (
        <Box gap={1}>
          <GradientBar value={barValue} width={barWidth} />
          <Text dimColor>{nmLabel}</Text>
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
