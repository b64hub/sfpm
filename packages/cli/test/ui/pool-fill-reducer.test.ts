import {expect} from 'chai';

import type {Action, PoolFillState} from '../../src/ui/state/pool-fill-reducer.js';

import {initialState, reducer} from '../../src/ui/state/pool-fill-reducer.js';

function play(actions: Action[], state: PoolFillState = initialState('my-devhub')): PoolFillState {
  let next = state;
  for (const action of actions) next = reducer(next, action);
  return next;
}

describe('ui: pool-fill-reducer — concurrent pools', () => {
  it('tracks two pools independently and stays "provisioning" until both finish', () => {
    let state = play([
      {tag: 'dev-pool', total: 2, type: 'pool:start'},
      {tag: 'qa-pool', total: 1, type: 'pool:start'},
      {
        alias: 'dev-1', tag: 'dev-pool', type: 'org:appeared', username: 'dev-1@scratch',
      },
      {
        alias: 'qa-1', tag: 'qa-pool', type: 'org:appeared', username: 'qa-1@scratch',
      },
    ]);

    expect(state.pools.map(p => p.tag)).to.deep.equal(['dev-pool', 'qa-pool']);
    expect(state.phase).to.equal('provisioning');

    // qa-pool's only org finishes — qa-pool is done, dev-pool is not, so the
    // app must not exit yet.
    state = play([
      {type: 'org:done', username: 'qa-1@scratch'},
      {tag: 'qa-pool', type: 'pool:done'},
    ], state);

    expect(state.pools.find(p => p.tag === 'qa-pool')?.done).to.equal(true);
    expect(state.pools.find(p => p.tag === 'dev-pool')?.done).to.equal(false);
    expect(state.phase).to.equal('provisioning');

    // dev-pool's org finishes too — now every pool is done.
    state = play([
      {type: 'org:done', username: 'dev-1@scratch'},
      {tag: 'dev-pool', type: 'pool:done'},
    ], state);

    expect(state.phase).to.equal('done');
  });

  it('scopes pending/creation-failed counts to the pool that reported them', () => {
    const state = play([
      {tag: 'dev-pool', total: 2, type: 'pool:start'},
      {tag: 'qa-pool', total: 3, type: 'pool:start'},
      {
        alias: 'dev-1', tag: 'dev-pool', type: 'org:appeared', username: 'dev-1@scratch',
      },
      {
        alias: 'qa-1', tag: 'qa-pool', type: 'org:appeared', username: 'qa-1@scratch',
      },
      {tag: 'qa-pool', type: 'pool:creation:failed'},
    ]);

    const devPool = state.pools.find(p => p.tag === 'dev-pool')!;
    const qaPool = state.pools.find(p => p.tag === 'qa-pool')!;

    expect(devPool.creationFailed).to.equal(0);
    expect(qaPool.creationFailed).to.equal(1);
    // qa-pool: total 3, 1 appeared, 1 creation-failed → 1 still pending
    expect(qaPool.total - state.orgs.filter(o => o.tag === 'qa-pool').length - qaPool.creationFailed).to.equal(1);
  });

  it('appends static items in chronological order across interleaved pools', () => {
    const state = play([
      {tag: 'dev-pool', total: 1, type: 'pool:start'},
      {tag: 'qa-pool', total: 1, type: 'pool:start'},
      {
        alias: 'qa-1', tag: 'qa-pool', type: 'org:appeared', username: 'qa-1@scratch',
      },
      {type: 'org:done', username: 'qa-1@scratch'},
      {
        alias: 'dev-1', tag: 'dev-pool', type: 'org:appeared', username: 'dev-1@scratch',
      },
      {type: 'org:done', username: 'dev-1@scratch'},
    ]);

    expect(state.staticItems.map(i => i.id)).to.deep.equal([
      'header:dev-pool', 'header:qa-pool', 'qa-1@scratch', 'dev-1@scratch',
    ]);
  });
});
