import type EventEmitter from 'node:events';

import {
  Box, Static, Text, useApp, useInput,
} from 'ink';
import React, {useEffect, useReducer} from 'react';

import type {PackageCounts} from '../state/selectors.js';

import {Divider} from '../components/base/Divider.js';
import {ElapsedTime} from '../components/base/ElapsedTime.js';
import {Footer} from '../components/base/Footer.js';
import {OrgBadge} from '../components/base/OrgBadge.js';
import {OrgRow} from '../components/pool/OrgRow.js';
import {useTermWidth} from '../hooks/use-term-width.js';
import {colWidth, rawSym} from '../renderer-utils.js';
import {
  type Action, initialState, type OrgEntry, reducer, TERMINAL,
} from '../state/pool-fill-reducer.js';

// ── Bus wiring ────────────────────────────────────────────────────────────────

const BUS_EVENTS: Array<Action['type']> = [
  'pool:start',
  'org:appeared',
  'pool:creation:failed',
  'org:prereqs',
  'org:deploying',
  'org:pkg:start',
  'org:pkg:done',
  'org:done',
  'org:failed',
  'pool:done',
];

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

// ── Static items ─────────────────────────────────────────────────────────────

const ALIAS_COL = 20;

function StaticOrgRow({alias, completedPackages, failedPackages, phase, showTag, tag, totalPackages}: OrgEntry & {showTag: boolean}) {
  let icon: string;
  let color: string;
  let summary: string;

  if (phase === 'done') {
    icon    = rawSym.success;
    color   = 'green';
    summary = `${completedPackages}/${totalPackages} packages`;
  } else if (phase === 'warning') {
    icon    = rawSym.warn;
    color   = 'yellow';
    const installed = completedPackages - failedPackages;
    summary = `${installed}/${totalPackages} packages · ${failedPackages} failed`;
  } else {
    icon    = rawSym.fail;
    color   = 'red';
    summary = totalPackages > 0
      ? `failed · ${completedPackages}/${totalPackages} packages before failure`
      : 'failed';
  }

  return (
    <Box gap={1}>
      <Text color={color}>{icon}</Text>
      <Box width={ALIAS_COL}><Text wrap='truncate'>{showTag ? `${tag}/${alias}` : alias}</Text></Box>
      <Text dimColor>{summary}</Text>
    </Box>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

/** Max active org rows shown in the live area. Orgs beyond this are summarised. */
const MAX_ACTIVE_ROWS = 8;

export function PoolFillApp({bus, devhubAlias, onAdvance}: {bus: EventEmitter; devhubAlias: string; onAdvance?: (key: string) => void}) {
  const [state, dispatch] = useReducer(reducer, devhubAlias, initialState);
  const {exit} = useApp();
  const termWidth = useTermWidth();
  const barWidth   = colWidth(termWidth);

  useBusWiring(bus, dispatch);
  useInput((input, key) => {
    onAdvance?.(input || (key.escape ? '\u001B' : ''));
  }, {isActive: Boolean(onAdvance)});

  useEffect(() => {
    if (state.phase === 'done') {
      const t = setTimeout(exit, 80);
      return () => clearTimeout(t);
    }
  }, [state.phase, exit]);

  const multiPool     = state.pools.length > 1;
  const activeOrgs    = state.orgs.filter(o => !TERMINAL.has(o.phase));
  const doneOrgs      = state.orgs.filter(o => o.phase === 'done').length;
  const warningOrgs   = state.orgs.filter(o => o.phase === 'warning').length;
  const creationFailed = state.pools.reduce((sum, p) => sum + p.creationFailed, 0);
  const totalFailed   = state.orgs.filter(o => o.phase === 'failed').length + creationFailed;
  const totalDone     = doneOrgs + warningOrgs;
  const total         = state.pools.reduce((sum, p) => sum + p.total, 0);
  const pending       = state.pools.reduce((sum, p) => sum + Math.max(0, p.total - state.orgs.filter(o => o.tag === p.tag).length - p.creationFailed), 0);

  const counts: PackageCounts = {
    failed: totalFailed,
    pending,
    running: activeOrgs.length,
    skipped: 0,
    success: totalDone,
    total,
    validating: 0,
  };

  const visibleActive = activeOrgs.slice(0, MAX_ACTIVE_ROWS);
  const hiddenCount   = activeOrgs.length - visibleActive.length;
  const startedAt     = state.pools.length > 0 ? Math.min(...state.pools.map(p => p.startedAt)) : Date.now();

  return (
    <Box flexDirection='column'>

      {/* Devhub badge — always shown once, above any pool sections */}
      {state.pools.length > 0 && <OrgBadge alias={devhubAlias} />}

      {/* Static block: one header per pool (as it starts), org rows as each finishes */}
      <Static items={state.staticItems}>
        {item => item.kind === 'header'
          ? (
            <Box flexDirection='column' key={item.id}>
              <Text bold>
                Provisioning {item.total} org{item.total === 1 ? '' : 's'} · {item.tag}
              </Text>
              <Divider width={termWidth} />
            </Box>
          )
          : <StaticOrgRow key={item.id} {...item.org} showTag={multiPool} />
        }
      </Static>

      {/* Active org rows */}
      <Box flexDirection='column' marginTop={1}>
        {visibleActive.map(org => (
          <OrgRow barWidth={barWidth} key={org.username} {...org} alias={multiPool ? `${org.tag}/${org.alias}` : org.alias} />
        ))}
        {hiddenCount > 0 && (
          <Text dimColor>  · {hiddenCount} more provisioning...</Text>
        )}
      </Box>

      {/* Footer */}
      <Footer
        activeSlot={
          <Box gap={1}>
            {activeOrgs.length > 0 && <Text color='yellow'>{activeOrgs.length} provisioning</Text>}
            {activeOrgs.length > 0 && pending > 0 && <Text dimColor>·</Text>}
            {pending > 0 && <Text dimColor>{pending} queued</Text>}
          </Box>
        }
        counts={counts}
        progressBar={false}
        resultsSlot={
          <Box gap={2}>
            {doneOrgs > 0    && <Text color='green'>{doneOrgs} done</Text>}
            {warningOrgs > 0 && <Text color='yellow'>{warningOrgs} ⚠</Text>}
            {totalFailed > 0 && <Text color='red'>{totalFailed} ✗</Text>}
          </Box>
        }
        timeSlot={<ElapsedTime dimColor startedAt={startedAt} />}
      />

    </Box>
  );
}
