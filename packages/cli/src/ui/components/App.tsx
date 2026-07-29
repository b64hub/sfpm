import type EventEmitter from 'node:events';

import {Box, Text, useInput} from 'ink';
import {useReducer} from 'react';

import {useEventBusWiring} from '../hooks/use-event-bus-wiring.js';
import {initialState, reducer} from '../state/reducer.js';
import {countPackages} from '../state/selectors.js';
import {Footer} from './base/Footer.js';
import {OrchestrationView} from './OrchestrationView.js';
import {PackageRow} from './PackageRow.js';
import type {MetaColSpec} from './PackageRow.js';

const META_COLS: MetaColSpec[] = [
  {key: 'components', width: 5,  label: 'cmp'},
  {key: 'version',    width: 7,  label: 'ver'},
  {key: 'hash',       width: 8,  label: 'hash'},
];

export function App({bus, logPath, onAdvance}: {bus: EventEmitter; logPath?: string; onAdvance?: (key: string) => void}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  useEventBusWiring(bus, dispatch);
  useInput((input, key) => { onAdvance?.(input || (key.escape ? '\x1b' : '')); }, {isActive: Boolean(onAdvance)});

  const counts = countPackages(state.levels);

  return (
    <Box flexDirection="column">
      {state.levels.length > 0 && (
        <OrchestrationView
          levels={state.levels}
          validation={state.validation}
          getColumns={node => <PackageRow.MetaCols cols={META_COLS} meta={node.meta} />}
          headerColumns={<PackageRow.MetaCols cols={META_COLS} header />}
        />
      )}
      <Footer
        counts={counts}
        progressBar={state.phase === 'running'}
        activeSlot={<Footer.Active counts={counts} />}
        resultsSlot={<Footer.Results counts={counts} />}
        timeSlot={state.startedAt !== undefined
          ? <Footer.Elapsed startedAt={state.startedAt} dimColor />
          : undefined}
      />
      {state.phase === 'failed' && logPath && (
        <Text dimColor>Full logs: {logPath}</Text>
      )}
    </Box>
  );
}
