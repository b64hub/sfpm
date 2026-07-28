import {Box, Static} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus} from '../state/selectors.js';
import {LevelRow} from './LevelRow.js';

const TERMINAL = new Set(['success', 'failed', 'skipped']);

export function LevelsView({levels}: {levels: TreeNode[]}) {
  const done = levels.filter(l => TERMINAL.has(deriveStatus(l.children)));
  const active = levels.filter(l => !TERMINAL.has(deriveStatus(l.children)));

  return (
    <Box flexDirection="column">
      <Static items={done}>
        {level => (
          <Box key={level.id} marginBottom={1}>
            <LevelRow node={level} />
          </Box>
        )}
      </Static>
      {active.map(level => <LevelRow key={level.id} node={level} />)}
    </Box>
  );
}
