import {ProgressBar} from '@inkjs/ui';
import {useAnimation} from 'ink';
import {Box, Text} from 'ink';

import type {AppState} from '../state/types.js';
import type {PackageCounts} from '../state/selectors.js';

import {countPackages} from '../state/selectors.js';
import {rawSym} from '../renderer-utils.js';

function ElapsedTimer({startedAt}: {startedAt: number}) {
  useAnimation({interval: 1000});
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return <Text dimColor>{Math.floor(s / 60)}:{String(s % 60).padStart(2, '0')}</Text>;
}


export function Footer({
  levels, phase, startedAt,
}: {
  levels: AppState['levels'];
  phase: AppState['phase'];
  startedAt?: number;
}) {
  const counts: PackageCounts = countPackages(levels);
  const done = counts.success + counts.skipped;
  const completed = done + counts.failed;
  return (
    <Box gap={2} marginTop={1} borderStyle="single" borderBottom={false} borderLeft={false} borderRight={false} borderDimColor>
      {phase === 'building' && counts.total > 0 && (
        <Box width={20}>
          <ProgressBar value={Math.round((completed / counts.total) * 100)} />
        </Box>
      )}
      <Text color="green">{done} done</Text>
      {counts.failed > 0 && <Text color="red">{counts.failed} {rawSym.fail}</Text>}
      {counts.running > 0 && <Text color="yellow">{counts.running} running</Text>}
      {counts.pending > 0 && <Text dimColor>{counts.pending} queued</Text>}
      {startedAt !== undefined && <ElapsedTimer startedAt={startedAt} />}
    </Box>
  );
}
