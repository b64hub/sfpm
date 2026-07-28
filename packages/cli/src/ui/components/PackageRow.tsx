import {Box, Text} from 'ink';

import type {TreeNode} from '../state/types.js';

import {StatusIcon} from './StatusIcon.js';

export function PackageRow({node}: {node: TreeNode}) {
  return (
    <Box flexDirection="column">
      <Box gap={1}>
        <StatusIcon status={node.status} />
        <Text>{node.label}</Text>
        {node.detail && <Text dimColor>{node.detail}</Text>}
      </Box>
      {node.children.map(step => (
        <Box key={step.id} marginLeft={2} gap={1}>
          <StatusIcon status={step.status} />
          <Text dimColor>{step.label}</Text>
          {step.detail && <Text dimColor> {step.detail}</Text>}
        </Box>
      ))}
    </Box>
  );
}
