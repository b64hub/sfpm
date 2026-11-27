import {describe, expect, it, vi} from 'vitest';

import {DeployValidationResolver} from '../../../src/package/validation/deploy-validation-resolver.js';

const installAll = vi.fn();

vi.mock('@salesforce/core', () => ({
  Org: {create: vi.fn(async () => ({}))},
}));

vi.mock('../../../src/orchestrator/install-orchestrator.js', () => ({
  InstallOrchestrator: {
    forArtifact: vi.fn(() => ({installAll})),
  },
}));

describe('DeployValidationResolver', () => {
  it('carries errorDetails from a failed orchestration result into the failed validation state', async () => {
    const errorDetails = [
      {label: 'ApexClass:Foo', message: 'Compile error'},
      {label: 'CustomField:Bar', message: 'Invalid field'},
    ];
    installAll.mockResolvedValue({
      results: [
        {packageName: 'pkg-a', success: false, error: 'Deploy failed', errorDetails},
        {packageName: 'pkg-b', success: true},
      ],
    });

    const resolver = new DeployValidationResolver({} as any, {} as any);
    const {primary} = await resolver.resolve([
      {operationType: 'deploy', packageName: 'pkg-a', targetOrg: 'dev', testLevel: 'RunLocalTests'},
      {operationType: 'deploy', packageName: 'pkg-b', targetOrg: 'dev', testLevel: 'RunLocalTests'},
    ], {});

    expect(primary.get('pkg-a')).to.deep.equal({
      checks: ['deploy'],
      error: 'Deploy failed',
      errorDetails,
      status: 'failed',
    });
    expect(primary.get('pkg-b')).to.deep.equal({checks: ['deploy'], status: 'passed'});
  });
});
