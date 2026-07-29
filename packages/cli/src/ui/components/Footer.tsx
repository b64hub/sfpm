import {useAnimation} from 'ink';
import {Box, Text} from 'ink';

import type {AppState} from '../state/types.js';
import type {PackageCounts} from '../state/selectors.js';

import {countPackages} from '../state/selectors.js';
import {rawSym} from '../renderer-utils.js';

// ---- gradient progress bar ----

const BAR_WIDTH = 20;

/** Blue (#0000ff) → Red (#ff0000) gradient, one Text node per character. */
function GradientBar({value}: {value: number}) {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * BAR_WIDTH);
  return (
    <Box>
      {Array.from({length: BAR_WIDTH}, (_, i) => {
        if (i >= filled) return <Text key={i} dimColor>░</Text>;
        const t = i / (BAR_WIDTH - 1);
        const r = Math.round(t * 255).toString(16).padStart(2, '0');
        const b = Math.round((1 - t) * 255).toString(16).padStart(2, '0');
        return <Text key={i} color={`#${r}00${b}`}>█</Text>;
      })}
    </Box>
  );
}

// ---- elapsed timer ----

function ElapsedTimer({startedAt}: {startedAt: number}) {
  useAnimation({interval: 1000});
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return <Text dimColor>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</Text>;
}

// ---- footer ----

export function Footer({
  levels, phase, startedAt, progressBar = true,
}: {
  levels: AppState['levels'];
  phase: AppState['phase'];
  startedAt?: number;
  /** Show the gradient progress bar. Defaults to true. */
  progressBar?: boolean;
}) {
  const counts: PackageCounts = countPackages(levels);
  const done = counts.success + counts.skipped;
  const completed = done + counts.failed;
  return (
    <Box gap={2} marginTop={1} marginBottom={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderDimColor>
      {progressBar && phase === 'building' && counts.total > 0 && (
        <GradientBar value={Math.round((completed / counts.total) * 100)} />
      )}
      <Text color="green">{done} done</Text>
      {counts.failed > 0 && <Text color="red">{counts.failed} {rawSym.fail}</Text>}
      {counts.running > 0 && <Text color="yellow">{counts.running} running</Text>}
      {counts.pending > 0 && <Text dimColor>{counts.pending} queued</Text>}
      {startedAt !== undefined && <ElapsedTimer startedAt={startedAt} />}
    </Box>
  );
}
