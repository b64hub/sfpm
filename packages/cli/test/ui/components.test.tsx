import React from 'react';
import {renderToString} from 'ink';
import {expect} from 'chai';

import {StatusIcon} from '../../src/ui/components/StatusIcon.js';
import {PackageRow} from '../../src/ui/components/PackageRow.js';
import {toPackageRowProps} from '../../src/ui/state/selectors.js';
import {OrchestrationView} from '../../src/ui/components/OrchestrationView.js';
import {ValidationView} from '../../src/ui/components/ValidationView.js';
import {Footer} from '../../src/ui/components/Footer.js';
import type {TreeNode} from '../../src/ui/state/types.js';

// ---- helpers ----

function pkg(label: string, status: TreeNode['status'] = 'pending', detail?: string, children: TreeNode[] = []): TreeNode {
  return {id: `pkg:${label}`, label, status, detail, children};
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
  it('renders running spinner', () => {
    // renderToString is synchronous — spinner always shows frame 0
    expect(renderToString(<StatusIcon status="running" />)).to.include('⠋');
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
    const out = renderToString(<PackageRow props={toPackageRowProps(pkg('core-utils', 'success'))} />);
    expect(out).to.include('core-utils');
  });

  it('shows "done" status label for success', () => {
    const out = renderToString(<PackageRow props={toPackageRowProps(pkg('core-utils', 'success'))} />);
    expect(out).to.include('done');
  });

  it('shows "queued" status label for pending', () => {
    const out = renderToString(<PackageRow props={toPackageRowProps(pkg('app-shell', 'pending'))} />);
    expect(out).to.include('queued');
  });

  it('shows inline detail when present', () => {
    const out = renderToString(<PackageRow props={toPackageRowProps(pkg('ui-kit', 'failed', 'TS2307'))} />);
    expect(out).to.include('TS2307');
  });

  it('is collapsed when success — children not shown', () => {
    const step: TreeNode = {id: 'step:stage', label: 'stage', status: 'success', children: []};
    const out = renderToString(<PackageRow props={toPackageRowProps({...pkg('core-utils', 'success'), children: [step]})} />);
    expect(out).not.to.include('stage');
  });

  it('is expanded when running — shows step children', () => {
    const step: TreeNode = {id: 'step:stage', label: 'stage', status: 'running', children: []};
    const out = renderToString(<PackageRow props={toPackageRowProps({...pkg('core-utils', 'running'), children: [step]})} />);
    expect(out).to.include('stage');
  });

  it('is expanded when failed — shows step children with connector', () => {
    const step: TreeNode = {id: 'step:stage', label: 'stage', status: 'failed', detail: 'exit 1', children: []};
    const out = renderToString(<PackageRow props={toPackageRowProps({...pkg('ui-kit', 'failed'), children: [step]})} />);
    expect(out).to.include('stage');
    expect(out).to.include('exit 1');
    expect(out).to.include('└');
  });

  it('shows running step label as inline hint', () => {
    const step: TreeNode = {id: 'step:compile', label: 'compile', status: 'running', children: []};
    const out = renderToString(<PackageRow props={toPackageRowProps({...pkg('core-utils', 'running'), children: [step]})} />);
    expect(out).to.include('compile');
  });

  it('caller can force-collapse regardless of status', () => {
    // step label becomes the inline hint, so check that step-child-specific output is absent
    const step: TreeNode = {id: 'step:compile', label: 'compile', status: 'running', detail: 'unique-step-detail', children: []};
    const rowProps = {...toPackageRowProps({...pkg('core-utils', 'running'), children: [step]}), collapsed: true};
    const out = renderToString(<PackageRow props={rowProps} />);
    expect(out).not.to.include('unique-step-detail'); // step child detail never shown
    expect(out).not.to.include('└');                    // no connector when collapsed
  });
});

// ---- OrchestrationView ----

describe('OrchestrationView', () => {
  it('renders summary header with package and level counts', () => {
    const levels = [
      level(0, [pkg('core-utils', 'success')]),
      level(1, [pkg('app-shell', 'running')]),
    ];
    const out = renderToString(<OrchestrationView levels={levels} />);
    expect(out).to.include('2 packages');
    expect(out).to.include('2 levels');
  });

  it('renders package names', () => {
    const levels = [level(0, [pkg('core-utils', 'success'), pkg('app-shell', 'running')])];
    const out = renderToString(<OrchestrationView levels={levels} />);
    expect(out).to.include('core-utils');
    expect(out).to.include('app-shell');
  });

  it('shows truncation when queued packages exceed limit', () => {
    const pkgs = Array.from({length: 6}, (_, i) => pkg(`pkg-${i}`, 'pending'));
    const out = renderToString(<OrchestrationView levels={[level(0, pkgs)]} />);
    expect(out).to.include('more queued');
  });

  it('renders nothing extra for empty levels', () => {
    const out = renderToString(<OrchestrationView levels={[]} />);
    expect(out).to.include('0 packages');
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
  it('shows done and queued counts', () => {
    const levels = [level(0, [pkg('a', 'success'), pkg('b', 'failed'), pkg('c', 'pending')])];
    const out = renderToString(<Footer levels={levels} phase="building" />);
    expect(out).to.include('done');
    expect(out).to.include('queued');
  });
});
