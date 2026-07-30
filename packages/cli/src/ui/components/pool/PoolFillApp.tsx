import type {PackageCounts} from '../../state/selectors.js';
import type EventEmitter from 'node:events';

import {Box, Static, Text, useApp, useInput} from 'ink';
import React, {useEffect, useReducer} from 'react';

import {ElapsedTime} from '../base/ElapsedTime.js';
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
  devhubAlias: string;
  orgs: OrgEntry[];
  phase: 'done' | 'failed' | 'idle' | 'provisioning';
  startedAt: number;
  tag: string;
  /**
   * Snapshot of all orgs in insertion order, populated atomically when pool:done fires.
   * Empty during provisioning — Static only renders at the very end.
   */
  terminalOrgs: OrgEntry[];
  total: number;
}

function initialState(devhubAlias: string): PoolFillState {
  return {
    devhubAlias,
    orgs: [],
    phase: 'idle',
    startedAt: Date.now(),
    tag: '',
    terminalOrgs: [],
    total: 0,
  };
}

const TERMINAL: Set<OrgPhase> = new Set(['done', 'warning', 'failed']);

// ── Reducer ───────────────────────────────────────────────────────────────────

type Action =
  | {type: 'org:appeared';       alias: string; username: string}
  | {type: 'org:deploying';      username: string}
  | {type: 'org:done';           username: string}
  | {type: 'org:failed';         username: string}
  | {type: 'org:pkg:done';       packageName: string; success: boolean; username: string; version?: string}
  | {type: 'org:pkg:start';      packageName: string; total: number; username: string}
  | {type: 'org:prereqs';        username: string}
  | {type: 'pool:creation:failed'; alias: string}
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
    // Org failed before it was created — no username, use alias as the unique key.
    return {
      ...state,
      orgs: [...state.orgs, {
        alias: action.alias,
        completedPackages: 0,
        failedPackages: 0,
        phase: 'failed',
        startedAt: Date.now(),
        totalPackages: 0,
        username: action.alias,
      }],
    };

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
    if (!org || TERMINAL.has(org.phase)) return state;
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: org.failedPackages > 0 ? 'warning' : 'done'})};
  }

  case 'org:failed': {
    const org = state.orgs.find(o => o.username === action.username);
    if (!org || TERMINAL.has(org.phase)) return state;
    return {...state, orgs: patchOrg(state.orgs, action.username, {phase: 'failed'})};
  }

  case 'pool:done':
    // Snapshot orgs in insertion order for the atomic static flush.
    return {...state, phase: 'done', terminalOrgs: [...state.orgs]};

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

type StaticItem =
  | {kind: 'header'; devhubAlias: string; id: string; tag: string; total: number}
  | {kind: 'org';    id: string; org: OrgEntry};

// ── Component ─────────────────────────────────────────────────────────────────

/** Max active org rows shown in the live area. Orgs beyond this are summarised. */
const MAX_ACTIVE_ROWS = 8;

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

  const activeOrgs  = state.orgs.filter(o => !TERMINAL.has(o.phase));
  const doneOrgs    = state.orgs.filter(o => o.phase === 'done').length;
  const warningOrgs = state.orgs.filter(o => o.phase === 'warning').length;
  const totalFailed = state.orgs.filter(o => o.phase === 'failed').length;
  const totalDone   = doneOrgs + warningOrgs;
  const pending     = Math.max(0, state.total - state.orgs.length);

  const counts: PackageCounts = {
    failed:    totalFailed,
    pending,
    running:   activeOrgs.length,
    skipped:   0,
    success:   totalDone,
    total:     state.total,
    validating: 0,
  };

  // Header flushed once on pool:start. Org results flushed atomically on pool:done
  // in insertion order, so the final list is stable and alphabetically ordered.
  const staticItems: StaticItem[] = [
    ...(state.total > 0 ? [{
      devhubAlias: state.devhubAlias,
      id: '__header__',
      kind: 'header' as const,
      tag: state.tag,
      total: state.total,
    }] : []),
    ...state.terminalOrgs.map(org => ({id: org.username, kind: 'org' as const, org})),
  ];

  const visibleOrgs = state.orgs.slice(0, MAX_ACTIVE_ROWS);
  const hiddenCount = state.orgs.length - visibleOrgs.length;

  return (
    <Box flexDirection="column">

      {/* Static block: header flushed once on start, org results flushed as each finishes */}
      <Static items={staticItems}>
        {item => item.kind === 'header'
          ? (
            <Box key={item.id} flexDirection="column" width={termWidth}>
              <OrgBadge alias={item.devhubAlias} />
              <Text bold>
                Provisioning {item.total} org{item.total !== 1 ? 's' : ''}{item.tag ? ` · ${item.tag}` : ''}
              </Text>
              <Divider width={termWidth} />
            </Box>
          )
          : <OrgRow key={item.id} {...item.org} />
        }
      </Static>

      {/* Active org rows — hidden once Static has taken over at pool:done */}
      {state.phase !== 'done' && (
        <Box flexDirection="column" marginTop={1}>
          {visibleOrgs.map(org => (
            <OrgRow key={org.username} barWidth={barWidth} {...org} />
          ))}
          {hiddenCount > 0 && (
            <Text dimColor>  · {hiddenCount} more...</Text>
          )}
        </Box>
      )}

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
