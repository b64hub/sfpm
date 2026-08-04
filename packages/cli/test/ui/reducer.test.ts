import {expect} from 'chai';

import {happyPathEvents} from '../../src/ui/fixtures/happy-path.js';
import {largeBuildEvents} from '../../src/ui/fixtures/large-scale.js';
import {partialFailureEvents} from '../../src/ui/fixtures/partial-failure.js';
import {ScenarioPlayer} from './scenario-player.js';

// ---- test helpers -----------------------------------------------------------

type Action = Record<string, unknown> & {type: string};

function init(levels: string[][]): Action {
  return {
    levels,
    type: 'orchestration:init',
  };
}

function running(packageName: string): Action {
  return {
    packageName,
    type: 'package:running',
  };
}

function complete(packageName: string, status: string, extra: Record<string, unknown> = {}): Action {
  return {
    packageName,
    status,
    type: 'package:complete',
    ...extra,
  };
}

function stepStart(packageName: string, step: string, detail?: string): Action {
  return {
    packageName,
    step,
    type: 'step:start',
    ...(detail ? {detail} : {}),
  };
}

function stepComplete(packageName: string, step: string, status: string, detail?: string): Action {
  return {
    packageName,
    status,
    step,
    type: 'step:complete',
    ...(detail ? {detail} : {}),
  };
}

function stepUpdate(packageName: string, step: string, detail: string): Action {
  return {
    detail,
    packageName,
    step,
    type: 'step:update',
  };
}

// =============================================================================

describe('ui: reducer', () => {
  // ---- orchestration:init ---------------------------------------------------

  describe('orchestration:init', () => {
    it('transitions to running and seeds the level tree', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils', 'shared-types'], ['app-shell']])]);
      const {levels, phase} = p.currentState();
      expect(phase).to.equal('running');
      expect(levels).to.have.length(2);
      expect(levels[0].children.map(c => c.label)).to.deep.equal(['core-utils', 'shared-types']);
      expect(levels[1].children[0].label).to.equal('app-shell');
    });

    it('all package nodes start as pending', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']])]);
      expect(p.currentState().levels[0].children[0].status).to.equal('pending');
    });
  });

  // ---- orchestration:complete -----------------------------------------------

  describe('orchestration:complete', () => {
    it('transitions to done on success', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        {
          success: true,
          type: 'orchestration:complete',
        },
      ]);
      expect(p.currentState().phase).to.equal('done');
    });

    it('stays in running on failure (leaves partial-failure state visible)', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        {
          success: false,
          type: 'orchestration:complete',
        },
      ]);
      expect(p.currentState().phase).to.equal('running');
    });
  });

  // ---- package:running / package:complete -----------------------------------

  describe('package:running', () => {
    it('sets package status to running', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils')]);
      expect(p.pkg('core-utils')?.status).to.equal('running');
    });

    it('records startedAt', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils')]);
      expect(p.pkg('core-utils')?.startedAt).to.be.a('number');
    });
  });

  describe('package:complete', () => {
    it('sets terminal status and clears startedAt', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils'), complete('core-utils', 'success')]);
      const pkg = p.pkg('core-utils');
      expect(pkg?.status).to.equal('success');
      expect(pkg?.startedAt).to.be.undefined;
    });

    it('records elapsed duration', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils'), complete('core-utils', 'success')]);
      expect(p.pkg('core-utils')?.duration).to.be.a('number');
    });

    it('stores detail and meta on completion', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        running('pkg-a'),
        complete('pkg-a', 'success', {
          detail: 'built',
          meta: {version: '1.0.0'},
        }),
      ]);
      const pkg = p.pkg('pkg-a');
      expect(pkg?.detail).to.equal('built');
      expect(pkg?.meta?.version).to.equal('1.0.0');
    });

    it("'validating' is non-terminal — startedAt is preserved", () => {
      const p = new ScenarioPlayer();
      p.play([init([['pkg-a']]), running('pkg-a'), complete('pkg-a', 'validating')]);
      const pkg = p.pkg('pkg-a');
      expect(pkg?.status).to.equal('validating');
      expect(pkg?.startedAt).to.be.a('number');  // NOT cleared — still live
    });

    it("'validating' → 'success' clears startedAt and records duration", () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        running('pkg-a'),
        complete('pkg-a', 'validating'),
        stepStart('pkg-a', 'validate'),
        stepComplete('pkg-a', 'validate', 'success'),
        complete('pkg-a', 'success'),
      ]);
      const pkg = p.pkg('pkg-a');
      expect(pkg?.status).to.equal('success');
      expect(pkg?.startedAt).to.be.undefined;
      expect(pkg?.duration).to.be.a('number');
    });
  });

  // ---- step:start / step:complete / step:update ----------------------------

  describe('step:start', () => {
    it('creates a step node with running status', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils'), stepStart('core-utils', 'stage')]);
      const s = p.stepOf('core-utils', 'stage');
      expect(s?.status).to.equal('running');
    });

    it('accepts an optional detail', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['core-utils']]),
        running('core-utils'),
        stepStart('core-utils', 'build', 'SFDXUnlockedPackageBuilder'),
      ]);
      expect(p.stepOf('core-utils', 'build')?.detail).to.equal('SFDXUnlockedPackageBuilder');
    });
  });

  describe('step:complete', () => {
    it('updates step status without adding a duplicate', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['core-utils']]),
        running('core-utils'),
        stepStart('core-utils', 'stage'),
        stepComplete('core-utils', 'stage', 'success'),
      ]);
      expect(p.pkg('core-utils')?.children).to.have.length(1);
      expect(p.stepOf('core-utils', 'stage')?.status).to.equal('success');
    });

    it('records a failed step with detail', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['ui-kit']]),
        running('ui-kit'),
        stepStart('ui-kit', 'stage'),
        stepComplete('ui-kit', 'stage', 'failed', 'Cannot find module'),
      ]);
      const s = p.stepOf('ui-kit', 'stage');
      expect(s?.status).to.equal('failed');
      expect(s?.detail).to.equal('Cannot find module');
    });
  });

  describe('step:update', () => {
    it('changes only the detail, not the status', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        running('pkg-a'),
        complete('pkg-a', 'validating'),
        stepStart('pkg-a', 'validate'),
        stepUpdate('pkg-a', 'validate', 'polling (attempt 2)'),
      ]);
      const s = p.stepOf('pkg-a', 'validate');
      expect(s?.status).to.equal('running');              // unchanged
      expect(s?.detail).to.equal('polling (attempt 2)'); // updated
    });
  });

  // ---- validation sidebar --------------------------------------------------

  describe('validation:init', () => {
    it('transitions to validating and seeds the validation list', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a', 'pkg-b']]),
        {
          packages: ['pkg-a', 'pkg-b'],
          type: 'validation:init',
        },
      ]);
      const {phase, validation} = p.currentState();
      expect(phase).to.equal('validating');
      expect(validation.map(n => n.label)).to.deep.equal(['pkg-a', 'pkg-b']);
      expect(validation.every(n => n.status === 'pending')).to.be.true;
    });
  });

  describe('validation:update', () => {
    it('updates the named validation node', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        {
          packages: ['pkg-a'],
          type: 'validation:init',
        },
        {
          packageName: 'pkg-a',
          status: 'success',
          type: 'validation:update',
        },
      ]);
      expect(p.currentState().validation[0].status).to.equal('success');
    });
  });

  // ---- OrchestrationView derived-value scenarios ---------------------------
  // These mirror OrchestrationView computations so regressions are caught
  // before they become "why does the visual look wrong" moments.

  describe('priorActivePkgs logic', () => {
    it('Level 0 all-success packages stay visible when Level 1 starts building', () => {
      // This was the regression: activeLevels excluded fully-terminal Level 0,
      // so currentIdx became 0, and slice(0,0) produced an empty list.
      const p = new ScenarioPlayer();
      p.play([
        init([['core-utils', 'shared-types'], ['app-shell']]),
        running('core-utils'),
        running('shared-types'),
        complete('core-utils', 'success'),
        complete('shared-types', 'success'),
        running('app-shell'),
      ]);

      expect(p.currentBuildLevelIdx()).to.equal(1);
      expect(p.priorActivePkgs()).to.have.length(2);
      expect(p.priorActivePkgs().map(n => n.label)).to.deep.equal(['core-utils', 'shared-types']);
      expect(p.allTerminal()).to.be.false;
    });

    it('Level 0 validating packages stay visible when Level 1 starts building', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['core-utils', 'shared-types'], ['app-shell']]),
        running('core-utils'),
        running('shared-types'),
        complete('core-utils', 'validating'),
        stepStart('core-utils', 'validate'),
        complete('shared-types', 'validating'),
        stepStart('shared-types', 'validate'),
        running('app-shell'),
      ]);

      expect(p.currentBuildLevelIdx()).to.equal(1);
      expect(p.priorActivePkgs()).to.have.length(2);
      expect(p.priorActivePkgs().every(n => n.status === 'validating')).to.be.true;
    });

    it('mix of success and validating packages from Level 0 both visible', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['core-utils', 'shared-types'], ['app-shell']]),
        running('core-utils'),
        running('shared-types'),
        complete('core-utils', 'success'),
        complete('shared-types', 'validating'),
        stepStart('shared-types', 'validate'),
        running('app-shell'),
      ]);

      const prior = p.priorActivePkgs();
      expect(prior).to.have.length(2);
      expect(prior.find(n => n.label === 'core-utils')?.status).to.equal('success');
      expect(prior.find(n => n.label === 'shared-types')?.status).to.equal('validating');
    });

    it('no prior packages when Level 0 is the current build level', () => {
      const p = new ScenarioPlayer();
      p.play([init([['core-utils']]), running('core-utils')]);
      expect(p.priorActivePkgs()).to.have.length(0);
    });

    it('allTerminal fires only after validation also resolves', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a'], ['pkg-b']]),
        running('pkg-a'),
        complete('pkg-a', 'validating'),
        stepStart('pkg-a', 'validate'),
        running('pkg-b'),
        complete('pkg-b', 'success'),
      ]);
      expect(p.allTerminal()).to.be.false;  // pkg-a still validating

      p.play([
        stepComplete('pkg-a', 'validate', 'success'),
        complete('pkg-a', 'success'),
      ]);
      expect(p.allTerminal()).to.be.true;   // both terminal → atomic flush
    });
  });

  // ---- end-to-end fixture scenarios ----------------------------------------

  describe('happy path', () => {
    it('ends with phase done after all validation resolves', () => {
      const p = new ScenarioPlayer();
      p.play(happyPathEvents);
      expect(p.currentState().phase).to.equal('done');
    });

    it('core-utils and shared-types end as success with version meta', () => {
      const p = new ScenarioPlayer();
      p.play(happyPathEvents);
      expect(p.pkg('core-utils')?.status).to.equal('success');
      expect(p.pkg('core-utils')?.meta?.version).to.equal('1.2.0');
      expect(p.pkg('shared-types')?.status).to.equal('success');
    });

    it('app-shell completes without a validate step', () => {
      const p = new ScenarioPlayer();
      p.play(happyPathEvents);
      expect(p.pkg('app-shell')?.status).to.equal('success');
      expect(p.stepOf('app-shell', 'validate')).to.be.undefined;
    });
  });

  describe('partial failure', () => {
    it('failed package retains error detail', () => {
      const p = new ScenarioPlayer();
      p.play(partialFailureEvents);
      expect(p.pkg('ui-kit')?.status).to.equal('failed');
      expect(p.pkg('ui-kit')?.detail).to.equal('TS2307: Cannot find module');
    });

    it('failed stage step also carries the detail', () => {
      const p = new ScenarioPlayer();
      p.play(partialFailureEvents);
      expect(p.stepOf('ui-kit', 'stage')?.status).to.equal('failed');
      expect(p.stepOf('ui-kit', 'stage')?.detail).to.equal('TS2307: Cannot find module');
    });

    it('sibling package is unaffected', () => {
      const p = new ScenarioPlayer();
      p.play(partialFailureEvents);
      expect(p.pkg('core-utils')?.status).to.equal('success');
    });

    it('orchestration:complete with success:false does not change phase', () => {
      const p = new ScenarioPlayer();
      p.play(partialFailureEvents);
      expect(p.currentState().phase).to.equal('running');
    });

    it('a step still running when the package fails is flipped to failed', () => {
      // Regression: a step whose own completion event only fires on success
      // (e.g. deploy) never reaches a terminal state itself. Without this,
      // it renders as a permanently spinning/checked step next to a failed
      // package.
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        running('pkg-a'),
        stepStart('pkg-a', 'deploy'),
        complete('pkg-a', 'failed', {detail: 'Source deployment failed'}),
      ]);
      expect(p.pkg('pkg-a')?.status).to.equal('failed');
      expect(p.stepOf('pkg-a', 'deploy')?.status).to.equal('failed');
    });

    it('a step already terminal when the package fails keeps its own status', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        running('pkg-a'),
        stepStart('pkg-a', 'connect'),
        stepComplete('pkg-a', 'connect', 'success'),
        stepStart('pkg-a', 'deploy'),
        complete('pkg-a', 'failed'),
      ]);
      expect(p.stepOf('pkg-a', 'connect')?.status).to.equal('success');
      expect(p.stepOf('pkg-a', 'deploy')?.status).to.equal('failed');
    });
  });

  describe('large scale', () => {
    it('Level 0 packages are all validating mid-build (before Level 1 starts)', () => {
      const uiKitIdx = largeBuildEvents.findIndex(e => e.type === 'package:running' && e.packageName === 'ui-kit');
      const p = new ScenarioPlayer();
      p.play(largeBuildEvents.slice(0, uiKitIdx));
      expect(p.currentState().levels[0].children.every(c => c.status === 'validating')).to.be.true;
      expect(p.allTerminal()).to.be.false;
    });

    it('Level 0 packages are visible as priorActivePkgs while Level 1 builds', () => {
      const uiKitIdx = largeBuildEvents.findIndex(e => e.type === 'package:running' && e.packageName === 'ui-kit');
      const p = new ScenarioPlayer();
      p.play(largeBuildEvents.slice(0, uiKitIdx + 1));
      expect(p.currentBuildLevelIdx()).to.equal(1);
      expect(p.priorActivePkgs()).to.have.length(3);
    });

    it('ui-kit fails with the expected detail', () => {
      const p = new ScenarioPlayer();
      p.play(largeBuildEvents);
      expect(p.pkg('ui-kit')?.status).to.equal('failed');
      expect(p.pkg('ui-kit')?.detail).to.include('tokens');
    });

    it('validation resolves for all Level 0 packages by end', () => {
      const p = new ScenarioPlayer();
      p.play(largeBuildEvents);
      expect(p.currentState().levels[0].children.every(c => c.status === 'success')).to.be.true;
    });

    it('allTerminal is true at the end', () => {
      const p = new ScenarioPlayer();
      p.play(largeBuildEvents);
      expect(p.allTerminal()).to.be.true;
    });
  });

  // ---- misc ----------------------------------------------------------------
  describe('unknown events', () => {
    it('are silently ignored', () => {
      const p = new ScenarioPlayer();
      p.play([
        init([['pkg-a']]),
        {
          packages: ['pkg-a'],
          type: 'install:start',
        },
      ]);
      expect(p.currentState().phase).to.equal('running');
    });
  });
});
