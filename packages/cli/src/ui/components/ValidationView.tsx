import {Box, Text} from 'ink';

import type {TreeNode} from '../state/types.js';

import {StatusIcon} from './StatusIcon.js';

export function ValidationView({nodes}: {nodes: TreeNode[]}) {
  return (
    <Box flexDirection="column">
      <Text bold>Validating</Text>
      {nodes.map(n => (
        <Box key={n.id} marginLeft={2} gap={1}>
          <StatusIcon status={n.status} />
          <Text>{n.label}</Text>
          {n.detail && <Text dimColor>{n.detail}</Text>}
        </Box>
      ))}
    </Box>
  );
}
