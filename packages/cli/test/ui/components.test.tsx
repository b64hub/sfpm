import React from 'react';
import {Text, renderToString} from 'ink';
import {expect} from 'chai';

import type {PackageRowProps} from '../../src/ui/components/PackageRow.js';
import type {TreeNode} from '../../src/ui/state/types.js';

import {StatusIcon} from '../../src/ui/components/StatusIcon.js';
import {PackageRow} from '../../src/ui/components/PackageRow.js';
import {OrchestrationView} from '../../src/ui/components/OrchestrationView.js';
import {ValidationView} from '../../src/ui/components/ValidationView.js';
import {Footer} from '../../src/ui/components/Footer.js';

// ---- helpers ----

function pkg(label: string, status: TreeNode['status'] = 'pending', detail?: string, children: TreeNode[] = []): TreeNode {
  return {id: `pkg:${label}`, label, status, detail, children};
}

function level(index: number, packages: TreeNode[]): TreeNode {
  return {id: `level:${index}`, label: `Level ${index}`, status: 'pending', children: packages};
}

/** Build minimal PackageRowProps — only set what the test needs. */
function row(overrides: Partial<PackageRowProps> & {primary: string}): PackageRowProps {
  return {
    id: `row:${overrides.primary}`,
    icon: <StatusIcon status="pending" />,
    expanded: false,
    steps: [],
    ...overrides,
  };
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
  it('renders the primary label', () => {
    expect(renderToString(<PackageRow props={row({primary: 'core-utils'})} />))
      .to.include('core-utils');
  });

  it('renders secondary text dim', () => {
    expect(renderToString(<PackageRow props={row({primary: 'ui-kit', secondary: 'compile step'})} />))
      .to.include('compile step');
  });

  it('renders trailing content', () => {
    const trailing = <Text>done</Text>;
    expect(renderToString(<PackageRow props={row({primary: 'core-utils', trailing})} />))
      .to.include('done');
  });

  it('hides steps when expanded is false', () => {
    const steps = [{id: 's1', icon: '✔', primary: 'stage', isLast: true}];
    expect(renderToString(<PackageRow props={row({primary: 'core-utils', steps, expanded: false})} />))
      .not.to.include('stage');
  });

  it('shows steps when expanded is true', () => {
    const steps = [{id: 's1', icon: '✔', primary: 'stage', isLast: true}];
    expect(renderToString(<PackageRow props={row({primary: 'core-utils', steps, expanded: true})} />))
      .to.include('stage');
  });

  it('shows step secondary text when expanded', () => {
    const steps = [{id: 's1', icon: '✖', primary: 'compile', secondary: 'exit 1', isLast: true}];
    const out = renderToString(<PackageRow props={row({primary: 'ui-kit', steps, expanded: true})} />);
    expect(out).to.include('exit 1');
    expect(out).to.include('└');
  });
});

// ---- OrchestrationView ----

describe('OrchestrationView', () => {
  it('renders summary header with counts', () => {
    const out = renderToString(<OrchestrationView levels={[
      level(0, [pkg('core-utils', 'success')]),
      level(1, [pkg('app-shell', 'running')]),
    ]} />);
    expect(out).to.include('2 packages');
    expect(out).to.include('2 levels');
  });

  it('renders all package names', () => {
    const out = renderToString(<OrchestrationView levels={[
      level(0, [pkg('core-utils', 'success'), pkg('app-shell', 'running')]),
    ]} />);
    expect(out).to.include('core-utils');
    expect(out).to.include('app-shell');
  });

  it('truncates queued packages beyond limit', () => {
    const pkgs = Array.from({length: 6}, (_, i) => pkg(`pkg-${i}`, 'pending'));
    expect(renderToString(<OrchestrationView levels={[level(0, pkgs)]} />))
      .to.include('more queued');
  });
});

// ---- ValidationView ----

describe('ValidationView', () => {
  it('shows the section heading and package names', () => {
    const nodes: TreeNode[] = [
      {id: 'validate:core-utils',   label: 'core-utils',   status: 'success', children: []},
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
