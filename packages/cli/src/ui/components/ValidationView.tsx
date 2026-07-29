import {Box, Text} from 'ink';

import type {TreeNode} from '../state/types.js';

import {Divider} from './Divider.js';
import { PackageRow } from './PackageRow.js';
import { toRowProps } from '../state/adapters.js';

export function ValidationView({nodes}: {nodes: TreeNode[]}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Divider label="Validating" />
      {nodes.map(n => (
        <PackageRow props={(toRowProps(n))}></PackageRow>
      ))}
    </Box>
  );
}
