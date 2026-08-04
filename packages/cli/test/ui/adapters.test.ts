import {expect} from 'chai';

import type {TreeNode} from '../../src/ui/state/types.js';

import {toRowProps} from '../../src/ui/state/adapters.js';

function node(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    children: [],
    id: 'pkg:cvc',
    label: 'cvc',
    status: 'running',
    ...overrides,
  };
}

describe('ui: adapters — toRowProps', () => {
  it('routes a failed package\'s detail through `error`, not `secondary`', () => {
    const props = toRowProps(node({
      children: [{children: [], id: 'pkg:cvc/step:deploy', label: 'deploy', status: 'running'}],
      detail: 'Source deployment failed',
      status: 'failed',
    }));

    expect(props.error).to.not.be.undefined;
    expect(props.secondary).to.be.undefined;
  });

  it('routes a non-failed package\'s detail through `secondary`, not `error`', () => {
    const props = toRowProps(node({detail: 'built', status: 'success'}));

    expect(props.secondary).to.not.be.undefined;
    expect(props.error).to.be.undefined;
  });

  it('does not touch step data — visibility is PackageRow\'s job, not the adapter\'s', () => {
    const props = toRowProps(node({
      children: [{children: [], id: 'pkg:cvc/step:deploy', label: 'deploy', status: 'running'}],
      detail: 'Source deployment failed',
      status: 'failed',
    }));

    expect(props.steps).to.have.length(1);
    expect(props.steps?.[0].icon).to.not.be.undefined; // still reflects the step's real (non-terminal) status
  });
});
