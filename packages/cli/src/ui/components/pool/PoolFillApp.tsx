import type {PackageCounts} from '../../state/selectors.js';
import type EventEmitter from 'node:events';

import {Box, Static, Text, useApp, useInput} from 'ink';
import React, {useEffect, useReducer} from 'react';

import {ElapsedTime} from '../PackageRow.js';
import {Footer} from '../base/Footer.js';
import {OrgBadge} from '../base/OrgBadge.js';
import {Divider} from '../base/Divider.js';
import {type OrgPhase, OrgRow} from './OrgRow.js';
import {colWidth, rawSym} from '../../renderer-utils.js';
import {useTermWidth} from '../../hooks/use-term-width.js';

// ── State ─────────────────────────────────────────────────────────────────────

interface OrgEntry {
  alias: string;
  completedPackages: number;
  currentPackage?: string;
  currentPackageVersion?: string;
  failedPackages: number;
  phase: OrgPhase;
  startedAt: number;
  totalPackages: number;
  username: string;
}

interface PoolFillState {
  creationFailed: number;
  devhubAlias: string;
  orgs: OrgEntry[];
  phase: 'done' | 'failed' | 'idle' | 'provisioning';
  startedAt: number;
  tag: string;
  total: number;
}

function initialState(devhubAlias: string): PoolFillState {
  return {
    creationFailed: 0,
    devhubAlias,
    orgs: [],
    phase: 'idle',
    startedAt: Date.now(),
    tag: '',
    total: 0,
  };
}

// ── Reducer ───────────────────────────────────────────────────────────────────

type Action =
  | {type: 'org:appeared';       alias: string; username: string}
  | {type: 'org:deploying';      username: string}
  | {type: 'org:done';           username: string}
  | {type: 'org:failed';         username: string}
  | {type: 'org:pkg:done';       packageName: string; success: boolean; username: string; version?: string}
  | {type: 'org:pkg:start';      packageName: string; total: number; username: string}
  | {type: 'org:prereqs';        username: string}
  | {type: 'pool:creation:failed'}
  | {type: 'pool:done'}
  | {type: 'pool:start';         tag: string; total: number};

function patchOrg(orgs: OrgEntry[], username: string, patch: Partial<OrgEntry>): OrgEntry[] {
  return orgs.map(o => o.username === username ? {...o, ...patch} : o);
}

function reducer(state: PoolFillState, action: Action): PoolFillState {
  switch (action.type) {
  case 'pool:start':
    return {...state, phase: 'provisioning', startedAt: Date.now(), tag: action.tag, total: action.total};

  case 'org:appeared':
    return {
      ...state,
      orgs: [...state.orgs, {
        alias: action.alias,
        completedPackages: 0,
        failedPackages: 0,
        phase: 'creating',
        startedAt: Date.now(),
        totalPackages: 0,
        username: action.username,
      }],
    };

  case 'pool:creation:failed':
    return {...state, creationFailed: state.creationFailed + 1};

  case 'org:prereqs':
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'prereqs'})};

  case 'org:deploying':
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'deploying'})};

  case 'org:pkg:start':
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {
        currentPackage: action.packageName,
        currentPackageVersion: undefined,
        totalPackages: action.total,
      }),
    };

  case 'org:pkg:done': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org) return state;
    return {
      ...state,
      orgs: patchOrg(state.orgs, action.username, {
        completedPackages: org.completedPackages + 1,
        currentPackageVersion: action.version,
        failedPackages: org.failedPackages + (action.success ? 0 : 1),
      }),
    };
  }

  case 'org:done': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org) return state;
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: org.failedPackages > 0 ? 'warning' : 'done'})};
  }

  case 'org:failed':
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'failed'})};

  case 'pool:done':
    return {...state, phase: 'done'};

  default:
    return state;
  }
}

// ── Bus wiring ────────────────────────────────────────────────────────────────

const BUS_EVENTS: Array<Action['type']> = [
  'pool:start', 'org:appeared', 'pool:creation:failed',
  'org:prereqs', 'org:deploying',
  'org:pkg:start', 'org:pkg:done',
  'org:done', 'org:failed', 'pool:done',
];

function useBusWiring(bus: EventEmitter, dispatch: React.Dispatch<Action>): void {
  useEffect(() => {
    const handlers = BUS_EVENTS.map(name => {
      const handler = (payload: unknown) =>
        dispatch({type: name, ...(payload as Record<string, unknown>)} as Action);
      bus.on(name, handler);
      return [name, handler] as const;
    });
    return () => { for (const [name, handler] of handlers) bus.off(name, handler); };
  }, [bus, dispatch]);
}

// ── Static items ─────────────────────────────────────────────────────────────

const ALIAS_COL = 20;

type StaticItem =
  | {kind: 'header'; devhubAlias: string; id: string; tag: string; total: number}
  | {kind: 'org';    id: string; org: OrgEntry};

function StaticOrgRow({alias, completedPackages, failedPackages, phase, totalPackages}: OrgEntry) {
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
      <Box width={ALIAS_COL}><Text wrap="truncate">{alias}</Text></Box>
      <Text dimColor>{summary}</Text>
    </Box>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

/** Max active org rows shown in the live area. Orgs beyond this are summarised. */
const MAX_ACTIVE_ROWS = 8;

const TERMINAL: Set<OrgPhase> = new Set(['done', 'warning', 'failed']);

export function PoolFillApp({bus, devhubAlias, onAdvance}: {bus: EventEmitter; devhubAlias: string; onAdvance?: (key: string) => void}) {
  const [state, dispatch] = useReducer(reducer, devhubAlias, initialState);
  const {exit} = useApp();
  const termWidth = useTermWidth();
  const barWidth   = colWidth(termWidth);

  useBusWiring(bus, dispatch);
  useInput((input, key) => { onAdvance?.(input || (key.escape ? '\x1b' : '')); }, {isActive: Boolean(onAdvance)});

  useEffect(() => {
    if (state.phase === 'done' || state.phase === 'failed') {
      const t = setTimeout(exit, 80);
      return () => clearTimeout(t);
    }
  }, [state.phase, exit]);

  const terminalOrgs  = state.orgs.filter(o => TERMINAL.has(o.phase));
  const activeOrgs    = state.orgs.filter(o => !TERMINAL.has(o.phase));
  const doneOrgs      = state.orgs.filter(o => o.phase === 'done').length;
  const warningOrgs   = state.orgs.filter(o => o.phase === 'warning').length;
  const totalFailed   = state.orgs.filter(o => o.phase === 'failed').length + state.creationFailed;
  const totalDone     = doneOrgs + warningOrgs;
  const pending       = Math.max(0, state.total - state.orgs.length - state.creationFailed);

  const counts: PackageCounts = {
    failed:    totalFailed,
    pending,
    running:   activeOrgs.length,
    skipped:   0,
    success:   totalDone,
    total:     state.total,
    validating: 0,
  };

  // Header is item 0 — appears once when pool:start fires.
  // Terminal orgs accumulate after it as they finish.
  const staticItems: StaticItem[] = [
    ...(state.total > 0 ? [{
      devhubAlias: state.devhubAlias,
      id: '__header__',
      kind: 'header' as const,
      tag: state.tag,
      total: state.total,
    }] : []),
    ...terminalOrgs.map(org => ({id: org.username, kind: 'org' as const, org})),
  ];

  const visibleActive = activeOrgs.slice(0, MAX_ACTIVE_ROWS);
  const hiddenCount   = activeOrgs.length - visibleActive.length;

  return (
    <Box flexDirection="column">

      {/* Static block: header flushed once on start, org results flushed as each finishes */}
      <Static items={staticItems}>
        {item => item.kind === 'header'
          ? (
            <Box key={item.id} flexDirection="column">
              <OrgBadge alias={item.devhubAlias} />
              <Text bold>
                Provisioning {item.total} org{item.total !== 1 ? 's' : ''}{item.tag ? ` · ${item.tag}` : ''}
              </Text>
              <Divider width={termWidth} />
            </Box>
          )
          : <StaticOrgRow key={item.id} {...item.org} />
        }
      </Static>

      {/* Active org rows */}
      <Box flexDirection="column" marginTop={1}>
        {visibleActive.map(org => (
          <OrgRow key={org.username} barWidth={barWidth} {...org} />
        ))}
        {hiddenCount > 0 && (
          <Text dimColor>  · {hiddenCount} more provisioning...</Text>
        )}
      </Box>

      {/* Footer */}
      <Footer
        counts={counts}
        progressBar={false}
        activeSlot={
          <Box gap={1}>
            {activeOrgs.length > 0 && <Text color="yellow">{activeOrgs.length} provisioning</Text>}
            {activeOrgs.length > 0 && pending > 0 && <Text dimColor>·</Text>}
            {pending > 0 && <Text dimColor>{pending} queued</Text>}
          </Box>
        }
        resultsSlot={
          <Box gap={2}>
            {doneOrgs > 0    && <Text color="green">{doneOrgs} done</Text>}
            {warningOrgs > 0 && <Text color="yellow">{warningOrgs} ⚠</Text>}
            {totalFailed > 0 && <Text color="red">{totalFailed} ✗</Text>}
          </Box>
        }
        timeSlot={<ElapsedTime startedAt={state.startedAt} dimColor />}
      />

    </Box>
  );
}
