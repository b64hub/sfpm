import type EventEmitter from 'node:events';

import {Box, Text, useApp, useInput} from 'ink';
import {useEffect, useReducer} from 'react';

import {useEventBusWiring} from '../hooks/use-event-bus-wiring.js';
import {initialState, reducer} from '../state/reducer.js';
import {countPackages} from '../state/selectors.js';
import {Footer} from '../components/base/Footer.js';
import {OrgBadge} from '../components/base/OrgBadge.js';
import {OrchestrationView} from '../components/OrchestrationView.js';
import {PackageRow} from '../components/PackageRow.js';
import type {MetaColSpec} from '../components/PackageRow.js';

const META_COLS: MetaColSpec[] = [
  {key: 'components', width: 5,  label: 'cmp'},
  {key: 'version',    width: 7,  label: 'ver'},
  {key: 'hash',       width: 8,  label: 'hash'},
];

export interface ConnectedOrg {
  alias: string;
  username?: string;
}

export function App({bus, logPath, onAdvance, org}: {bus: EventEmitter; logPath?: string; onAdvance?: (key: string) => void; org?: ConnectedOrg}) {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const {exit} = useApp();
  useEventBusWiring(bus, dispatch);
  useInput((input, key) => { onAdvance?.(input || (key.escape ? '\x1b' : '')); }, {isActive: Boolean(onAdvance)});

  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'failed') {
      const t = setTimeout(exit, 80);
      return () => clearTimeout(t);
    }
  }, [state.phase, exit]);

  const counts = countPackages(state.levels);

  return (
    <Box flexDirection="column">
      {org && <OrgBadge alias={org.alias} username={org.username} />}
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
