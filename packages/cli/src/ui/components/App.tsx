import type EventEmitter from 'node:events';

import {Box} from 'ink';
import {useReducer} from 'react';

import {useEventBusWiring} from '../hooks/useEventBusWiring.js';
import {initialState, reducer} from '../state/reducer.js';
import {Footer} from './Footer.js';
import {LevelsView} from './LevelsView.js';
import {ValidationView} from './ValidationView.js';

export function App({bus}: {bus: EventEmitter}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEventBusWiring(bus, dispatch);

  return (
    <Box flexDirection="column">
      {state.levels.length > 0 && <LevelsView levels={state.levels} />}
      {state.phase === 'validating' && <ValidationView nodes={state.validation} />}
      <Footer levels={state.levels} phase={state.phase} />
    </Box>
  );
}
