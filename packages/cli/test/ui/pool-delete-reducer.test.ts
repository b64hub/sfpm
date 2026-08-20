import {expect} from 'chai';

import type {Action, PoolDeleteState} from '../../src/ui/state/pool-delete-reducer.js';

import {initialState, reducer} from '../../src/ui/state/pool-delete-reducer.js';

function play(actions: Action[], state: PoolDeleteState = initialState('my-devhub')): PoolDeleteState {
  let next = state;
  for (const action of actions) next = reducer(next, action);
  return next;
}

describe('ui: pool-delete-reducer — concurrent pools', () => {
  it('tracks two pools independently and stays "running" until both finish', () => {
    let state = play([
      {tag: 'dev-pool', type: 'delete:start'},
      {tag: 'qa-pool', type: 'delete:start'},
      {count: 3, tag: 'dev-pool', type: 'delete:count'},
      {count: 1, tag: 'qa-pool', type: 'delete:count'},
    ]);

    expect(state.rows.map(r => r.tag)).to.deep.equal(['dev-pool', 'qa-pool']);
    expect(state.phase).to.equal('running');

    // qa-pool finishes first — dev-pool is still running, so the app must
    // not exit yet.
    state = play([
      {tag: 'qa-pool', type: 'delete:org:done'},
      {
        deleted: 1, errors: [], tag: 'qa-pool', type: 'delete:done',
      },
    ], state);

    expect(state.rows.find(r => r.tag === 'qa-pool')?.phase).to.equal('done');
    expect(state.rows.find(r => r.tag === 'dev-pool')?.phase).to.equal('running');
    expect(state.phase).to.equal('running');

    // dev-pool finishes too — now every pool is terminal.
    state = play([
      {tag: 'dev-pool', type: 'delete:org:done'},
      {tag: 'dev-pool', type: 'delete:org:done'},
      {tag: 'dev-pool', type: 'delete:org:done'},
      {
        deleted: 3, errors: [], tag: 'dev-pool', type: 'delete:done',
      },
    ], state);

    expect(state.phase).to.equal('done');
  });

  it('marks a pool with no matching orgs as "empty", not "failed"', () => {
    const state = play([
      {tag: 'empty-pool', type: 'delete:start'},
      {
        deleted: 0, errors: [], tag: 'empty-pool', type: 'delete:done',
      },
    ]);

    expect(state.rows[0].phase).to.equal('empty');
    expect(state.phase).to.equal('done');
  });

  it('marks partial failures as "warning" and total failures as "failed"', () => {
    const state = play([
      {tag: 'partial-pool', type: 'delete:start'},
      {
        deleted: 2, errors: ['org-3 failed'], tag: 'partial-pool', type: 'delete:done',
      },
      {tag: 'broken-pool', type: 'delete:start'},
      {
        deleted: 0, errors: ['org-1 failed'], tag: 'broken-pool', type: 'delete:done',
      },
    ]);

    expect(state.rows.find(r => r.tag === 'partial-pool')?.phase).to.equal('warning');
    expect(state.rows.find(r => r.tag === 'broken-pool')?.phase).to.equal('failed');
  });
});
