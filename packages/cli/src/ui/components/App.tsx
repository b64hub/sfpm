import type EventEmitter from 'node:events';

import {Box} from 'ink';
import {useReducer} from 'react';

import type {TreeNode} from '../state/types.js';

import {useEventBusWiring} from '../hooks/useEventBusWiring.js';
import {initialState, reducer} from '../state/reducer.js';
import {Footer} from './Footer.js';
import {OrchestrationView} from './OrchestrationView.js';

function getMeta(node: TreeNode): string | undefined {
  return node.meta?.components ? `${node.meta.components} cmp` : undefined;
}

export function App({bus}: {bus: EventEmitter}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEventBusWiring(bus, dispatch);

  return (
    <Box flexDirection="column">
      {state.levels.length > 0 && (
        <OrchestrationView
          levels={state.levels}
          validation={state.validation}
          getMeta={getMeta}
          metaLabel="cmp"
        />
      )}
      <Footer levels={state.levels} phase={state.phase} startedAt={state.startedAt} />
    </Box>
  );
}
