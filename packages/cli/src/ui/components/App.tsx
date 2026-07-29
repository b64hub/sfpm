import type EventEmitter from 'node:events';

import {Box} from 'ink';
import {useReducer} from 'react';

import type {TreeNode} from '../state/types.js';

import {useEventBusWiring} from '../hooks/useEventBusWiring.js';
import {initialState, reducer} from '../state/reducer.js';
import {countPackages} from '../state/selectors.js';
import {Footer} from './Footer.js';
import {OrchestrationView} from './OrchestrationView.js';

function getMeta(node: TreeNode): string | undefined {
  return node.meta?.components ? `${node.meta.components} cmp` : undefined;
}

export function App({bus}: {bus: EventEmitter}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEventBusWiring(bus, dispatch);

  const counts = countPackages(state.levels);

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
      <Footer
        counts={counts}
        progressBar={state.phase === 'building'}
        activeSlot={<Footer.Active counts={counts} />}
        resultsSlot={<Footer.Results counts={counts} />}
        timeSlot={state.startedAt !== undefined
          ? <Footer.Elapsed startedAt={state.startedAt} dimColor />
          : undefined}
      />
    </Box>
  );
}
