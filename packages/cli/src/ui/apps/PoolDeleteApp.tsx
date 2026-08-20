import type EventEmitter from 'node:events';

import {useSpinner} from '@inkjs/ui';
import {Box, Text, useApp} from 'ink';
import React, {useEffect, useReducer} from 'react';

import type {PackageCounts} from '../state/selectors.js';

import {ElapsedTime} from '../components/base/ElapsedTime.js';
import {Footer} from '../components/base/Footer.js';
import {OrgBadge} from '../components/base/OrgBadge.js';
import {rawSym} from '../renderer-utils.js';
import {
  type Action, initialState, type PoolDeleteRow, reducer,
} from '../state/pool-delete-reducer.js';

// ── Bus wiring ────────────────────────────────────────────────────────────────

const BUS_EVENTS: Array<Action['type']> = ['delete:start', 'delete:count', 'delete:org:done', 'delete:done'];

function useBusWiring(bus: EventEmitter, dispatch: React.Dispatch<Action>): void {
  useEffect(() => {
    const handlers = BUS_EVENTS.map(name => {
      const handler = (payload: unknown) =>
        dispatch({type: name, ...(payload as Record<string, unknown>)} as Action);
      bus.on(name, handler);
      return [name, handler] as const;
    });
    return () => {
      for (const [name, handler] of handlers) bus.off(name, handler);
    };
  }, [bus, dispatch]);
}

// ── Row ───────────────────────────────────────────────────────────────────────

const TAG_COL = 20;

// Isolated so the spinner hook only runs while the row is actually deleting.
function RunningIcon() {
  const {frame} = useSpinner({});
  return <Text color='yellow'>{frame}</Text>;
}

function DeleteRow({completed, deleted, errors, phase, tag, total}: PoolDeleteRow) {
  const tagNode = <Box width={TAG_COL}><Text wrap='truncate'>{tag}</Text></Box>;

  if (phase === 'running') {
    return (
      <Box gap={1}>
        <RunningIcon />
        {tagNode}
        <Text dimColor>{total === undefined ? 'querying...' : `deleting ${completed}/${total}`}</Text>
      </Box>
    );
  }

  if (phase === 'empty') {
    return (
      <Box gap={1}>
        <Text dimColor>·</Text>
        {tagNode}
        <Text dimColor>no orgs found</Text>
      </Box>
    );
  }

  const icon  = phase === 'done' ? rawSym.success : phase === 'warning' ? rawSym.warn : rawSym.fail;
  const color = phase === 'done' ? 'green' : phase === 'warning' ? 'yellow' : 'red';
  const summary = phase === 'failed' && deleted === 0
    ? `failed${errors[0] ? ` · ${errors[0]}` : ''}`
    : errors.length > 0
      ? `deleted ${deleted} org(s) · ${errors.length} failed`
      : `deleted ${deleted} org(s)`;

  return (
    <Box gap={1}>
      <Text color={color}>{icon}</Text>
      {tagNode}
      <Text dimColor>{summary}</Text>
    </Box>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

export function PoolDeleteApp({bus, devhubAlias}: {bus: EventEmitter; devhubAlias: string}) {
  const [state, dispatch] = useReducer(reducer, devhubAlias, initialState);
  const {exit} = useApp();

  useBusWiring(bus, dispatch);

  useEffect(() => {
    if (state.phase === 'done') {
      const t = setTimeout(exit, 80);
      return () => clearTimeout(t);
    }
  }, [state.phase, exit]);

  const runningRows = state.rows.filter(r => r.phase === 'running').length;
  const doneRows    = state.rows.filter(r => r.phase === 'done').length;
  const warningRows = state.rows.filter(r => r.phase === 'warning').length;
  const failedRows  = state.rows.filter(r => r.phase === 'failed').length;
  const emptyRows   = state.rows.filter(r => r.phase === 'empty').length;

  const counts: PackageCounts = {
    failed: failedRows,
    pending: 0,
    running: runningRows,
    skipped: emptyRows,
    success: doneRows + warningRows,
    total: state.rows.length,
    validating: 0,
  };
  const startedAt = state.rows.length > 0 ? Math.min(...state.rows.map(r => r.startedAt)) : Date.now();

  return (
    <Box flexDirection='column'>

      {state.rows.length > 0 && <OrgBadge alias={devhubAlias} />}

      <Box flexDirection='column' marginTop={1}>
        {state.rows.map(row => <DeleteRow key={row.tag} {...row} />)}
      </Box>

      <Footer
        counts={counts}
        progressBar={false}
        resultsSlot={
          <Box gap={2}>
            {doneRows > 0    && <Text color='green'>{doneRows} done</Text>}
            {warningRows > 0 && <Text color='yellow'>{warningRows} ⚠</Text>}
            {failedRows > 0  && <Text color='red'>{failedRows} ✗</Text>}
            {emptyRows > 0   && <Text dimColor>{emptyRows} empty</Text>}
          </Box>
        }
        showActive={false}
        timeSlot={<ElapsedTime dimColor startedAt={startedAt} />}
      />

    </Box>
  );
}
