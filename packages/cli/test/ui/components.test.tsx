import React from 'react';
import {renderToString} from 'ink';
import {expect} from 'chai';

import {StatusIcon} from '../../src/ui/components/StatusIcon.js';
import {PackageRow} from '../../src/ui/components/PackageRow.js';
import {LevelRow} from '../../src/ui/components/LevelRow.js';
import {LevelsView} from '../../src/ui/components/LevelsView.js';
import {ValidationView} from '../../src/ui/components/ValidationView.js';
import {Footer} from '../../src/ui/components/Footer.js';
import type {TreeNode} from '../../src/ui/state/types.js';

// ---- helpers ----

function pkg(label: string, status: TreeNode['status'] = 'pending', children: TreeNode[] = []): TreeNode {
  return {id: `pkg:${label}`, label, status, children};
}

function level(index: number, packages: TreeNode[]): TreeNode {
  return {id: `level:${index}`, label: `Level ${index}`, status: 'pending', children: packages};
}

// ---- StatusIcon ----

describe('StatusIcon', () => {
  it('renders success icon', () => {
    expect(renderToString(<StatusIcon status="success" />)).to.include('✔');
  });
  it('renders failed icon', () => {
    expect(renderToString(<StatusIcon status="failed" />)).to.include('✖');
  });
  it('renders running icon', () => {
    expect(renderToString(<StatusIcon status="running" />)).to.include('●');
  });
  it('renders pending icon', () => {
    expect(renderToString(<StatusIcon status="pending" />)).to.include('○');
  });
  it('renders skipped icon', () => {
    expect(renderToString(<StatusIcon status="skipped" />)).to.include('–');
  });
});

// ---- PackageRow ----

describe('PackageRow', () => {
  it('shows the package label', () => {
    const out = renderToString(<PackageRow node={pkg('core-utils', 'success')} />);
    expect(out).to.include('core-utils');
  });

  it('shows detail when present', () => {
    const node = {...pkg('ui-kit', 'failed'), detail: 'TS2307'};
    expect(renderToString(<PackageRow node={node} />)).to.include('TS2307');
  });

  it('renders step children', () => {
    const stepNode: TreeNode = {id: 'pkg:core-utils/step:stage', label: 'stage', status: 'success', children: []};
    const node = {...pkg('core-utils', 'running'), children: [stepNode]};
    const out = renderToString(<PackageRow node={node} />);
    expect(out).to.include('stage');
    expect(out).to.include('✔'); // step success icon
  });
});

// ---- LevelRow ----

describe('LevelRow', () => {
  it('renders level label and child packages', () => {
    const node = level(0, [pkg('pkg-a', 'success'), pkg('pkg-b', 'running')]);
    const out = renderToString(<LevelRow node={node} />);
    expect(out).to.include('Level 0');
    expect(out).to.include('pkg-a');
    expect(out).to.include('pkg-b');
  });

  it('derives running status when any child is running', () => {
    const node = level(0, [pkg('pkg-a', 'success'), pkg('pkg-b', 'running')]);
    const out = renderToString(<LevelRow node={node} />);
    expect(out).to.include('●'); // running icon
  });

  it('derives success status when all children succeed', () => {
    const node = level(0, [pkg('pkg-a', 'success'), pkg('pkg-b', 'success')]);
    const out = renderToString(<LevelRow node={node} />);
    expect(out).to.include('✔'); // derived success icon for the level
  });

  it('derives failed status when any child fails', () => {
    const node = level(0, [pkg('pkg-a', 'failed'), pkg('pkg-b', 'success')]);
    const out = renderToString(<LevelRow node={node} />);
    expect(out).to.include('✖');
  });
});

// ---- LevelsView ----

describe('LevelsView', () => {
  it('renders all levels', () => {
    const levels = [
      level(0, [pkg('core-utils', 'success')]),
      level(1, [pkg('app-shell', 'running')]),
    ];
    const out = renderToString(<LevelsView levels={levels} />);
    expect(out).to.include('Level 0');
    expect(out).to.include('Level 1');
    expect(out).to.include('core-utils');
    expect(out).to.include('app-shell');
  });

  it('renders nothing for empty levels', () => {
    expect(renderToString(<LevelsView levels={[]} />)).to.equal('');
  });
});

// ---- ValidationView ----

describe('ValidationView', () => {
  it('shows the section heading and package names', () => {
    const nodes: TreeNode[] = [
      {id: 'validate:core-utils', label: 'core-utils', status: 'success', children: []},
      {id: 'validate:shared-types', label: 'shared-types', status: 'pending', children: []},
    ];
    const out = renderToString(<ValidationView nodes={nodes} />);
    expect(out).to.include('Validating');
    expect(out).to.include('core-utils');
    expect(out).to.include('shared-types');
  });
});

// ---- Footer ----

describe('Footer', () => {
  it('shows phase and counts', () => {
    const levels = [level(0, [pkg('a', 'success'), pkg('b', 'failed'), pkg('c', 'running')])];
    const out = renderToString(<Footer levels={levels} phase="building" />);
    expect(out).to.include('building');
    expect(out).to.include('1 ✔');
    expect(out).to.include('1 ✖');
    expect(out).to.include('1 ●');
  });
});
