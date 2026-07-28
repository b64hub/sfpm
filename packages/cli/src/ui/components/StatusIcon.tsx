import {Text} from 'ink';

import type {NodeStatus} from '../state/types.js';

import {rawSym} from '../renderer-utils.js';

const ICONS: Record<NodeStatus, {char: string; color: string}> = {
  failed:  {char: rawSym.fail,     color: 'red'},
  pending: {char: rawSym.pending,  color: 'gray'},
  running: {char: rawSym.progress, color: 'yellow'},
  skipped: {char: rawSym.skipped,  color: 'gray'},
  success: {char: rawSym.success,  color: 'green'},
};

export function StatusIcon({status}: {status: NodeStatus}) {
  const {char, color} = ICONS[status];
  return <Text color={color}>{char}</Text>;
}
