import {expect} from 'chai';

import {happyPathEvents} from './fixtures/happy-path.js';
import {partialFailureEvents} from './fixtures/partial-failure.js';
import {ScenarioPlayer} from './scenario-player.js';

describe('reducer', () => {
  describe('build:start', () => {
    it('transitions to building and seeds the level tree', () => {
      const player = new ScenarioPlayer();
      player.play([{type: 'build:start', levels: [['core-utils', 'shared-types'], ['app-shell']]}]);
      const {phase, levels} = player.currentState();
      expect(phase).to.equal('building');
      expect(levels).to.have.length(2);
      expect(levels[0].children.map(c => c.label)).to.deep.equal(['core-utils', 'shared-types']);
      expect(levels[1].children[0].label).to.equal('app-shell');
    });

    it('all package nodes start as pending', () => {
      const player = new ScenarioPlayer();
      player.play([{type: 'build:start', levels: [['core-utils']]}]);
      expect(player.currentState().levels[0].children[0].status).to.equal('pending');
    });
  });

  describe('build:package:step', () => {
    it('creates a step node under the package on first event', () => {
      const player = new ScenarioPlayer();
      player.play([
        {type: 'build:start', levels: [['core-utils']]},
        {type: 'build:package:step', packageName: 'core-utils', step: 'stage', status: 'running'},
      ]);
      const pkg = player.currentState().levels[0].children[0];
      expect(pkg.children).to.have.length(1);
      expect(pkg.children[0]).to.deep.include({label: 'stage', status: 'running'});
    });

    it('updates the same step node rather than adding a duplicate', () => {
      const player = new ScenarioPlayer();
      player.play([
        {type: 'build:start', levels: [['core-utils']]},
        {type: 'build:package:step', packageName: 'core-utils', step: 'stage', status: 'running'},
        {type: 'build:package:step', packageName: 'core-utils', step: 'stage', status: 'success'},
      ]);
      const pkg = player.currentState().levels[0].children[0];
      expect(pkg.children).to.have.length(1);
      expect(pkg.children[0].status).to.equal('success');
    });
  });

  describe('happy path', () => {
    it('transitions to validating after validation:start', () => {
      const player = new ScenarioPlayer();
      player.play(happyPathEvents);
      expect(player.currentState().phase).to.equal('validating');
    });

    it('seeds the validation list from validation:start', () => {
      const player = new ScenarioPlayer();
      player.play(happyPathEvents);
      const {validation} = player.currentState();
      expect(validation.map(n => n.label)).to.deep.equal(['core-utils', 'shared-types']);
    });

    it('all validation packages end as success', () => {
      const player = new ScenarioPlayer();
      player.play(happyPathEvents);
      expect(player.currentState().validation.every(n => n.status === 'success')).to.be.true;
    });
  });

  describe('partial failure', () => {
    it('failed package retains error detail', () => {
      const player = new ScenarioPlayer();
      player.play(partialFailureEvents);
      const uiKit = player.currentState().levels[0].children.find(c => c.label === 'ui-kit');
      expect(uiKit?.status).to.equal('failed');
      expect(uiKit?.detail).to.equal('TS2307: Cannot find module');
    });

    it('sibling package is unaffected', () => {
      const player = new ScenarioPlayer();
      player.play(partialFailureEvents);
      const coreUtils = player.currentState().levels[0].children.find(c => c.label === 'core-utils');
      expect(coreUtils?.status).to.equal('success');
    });

    it('build:complete with success:false does not change phase', () => {
      const player = new ScenarioPlayer();
      player.play(partialFailureEvents);
      expect(player.currentState().phase).to.equal('building');
    });

    it('no validation list is created', () => {
      const player = new ScenarioPlayer();
      player.play(partialFailureEvents);
      expect(player.currentState().validation).to.have.length(0);
    });
  });

  describe('unknown events', () => {
    it('are ignored without error', () => {
      const player = new ScenarioPlayer();
      player.play([
        {type: 'build:start', levels: [['pkg-a']]},
        {type: 'install:start', packages: ['pkg-a']},
      ]);
      expect(player.currentState().phase).to.equal('building');
    });
  });
});
