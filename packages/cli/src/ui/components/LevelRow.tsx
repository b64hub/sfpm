import {Box, Text} from 'ink';

import type {TreeNode} from '../state/types.js';

import {deriveStatus} from '../state/selectors.js';
import {PackageRow} from './PackageRow.js';
import {StatusIcon} from './StatusIcon.js';

export function LevelRow({node}: {node: TreeNode}) {
  const status = deriveStatus(node.children);
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <StatusIcon status={status} />
        <Text dimColor bold>
          {node.label}
        </Text>
      </Box>
      <Box flexDirection="column" marginLeft={2}>
        {node.children.map(pkg => (
          <PackageRow key={pkg.id} node={pkg} />
        ))}
      </Box>
    </Box>
  );
}
