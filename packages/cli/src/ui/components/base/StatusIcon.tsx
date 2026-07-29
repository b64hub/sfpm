import {useSpinner} from '@inkjs/ui';
import {Text} from 'ink';

import type {NodeStatus} from '../../state/types.js';

import {rawSym} from '../../renderer-utils.js';

const ICONS: Record<Exclude<NodeStatus, 'running' | 'validating'>, {char: string; color: string}> = {
  failed:  {char: rawSym.fail,    color: 'red'},
  pending: {char: rawSym.pending, color: 'gray'},
  skipped: {char: rawSym.skipped, color: 'gray'},
  success: {char: rawSym.success, color: 'green'},
};

// Isolated component so the spinner hook only runs when the node is actually running.
function RunningIcon() {
  const {frame} = useSpinner({});
  return <Text color="yellow">{frame}</Text>;
}

export function StatusIcon({status}: {status: NodeStatus}) {
  if (status === 'running' || status === 'validating') return <RunningIcon />;
  const {char, color} = ICONS[status];
  return <Text color={color}>{char}</Text>;
}
