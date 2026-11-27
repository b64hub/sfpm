import {describe, expect, it, vi} from 'vitest';

import {ValidationResolver} from '../../../src/package/validation/validation-resolver.js';

const installAll = vi.fn();
const updateValidation = vi.fn(async () => {});

vi.mock('@salesforce/core', () => ({
  Org: {create: vi.fn(async () => ({}))},
}));

vi.mock('../../../src/orchestrator/install-orchestrator.js', () => ({
  InstallOrchestrator: {
    forArtifact: vi.fn(() => ({installAll})),
  },
}));

vi.mock('../../../src/artifacts/artifact-repository.js', () => ({
  ArtifactRepository: class {
    updateValidation = updateValidation;
  },
}));

describe('ValidationResolver', () => {
  it('does not persist errorDetails into dist/package.json validation metadata', async () => {
    const errorDetails = [{label: 'ApexClass:Foo', message: 'Compile error'}];
    installAll.mockResolvedValue({
      results: [{packageName: 'pkg-a', success: false, error: 'Deploy failed', errorDetails}],
    });
    updateValidation.mockClear();

    const provider = {getPackageDefinition: () => ({path: '/project/packages/pkg-a'})};
    const resolver = new ValidationResolver(provider as any, {} as any);
    const results = await resolver.resolve([
      {operationType: 'deploy', packageName: 'pkg-a', targetOrg: 'dev', testLevel: 'RunLocalTests'},
    ]);

    expect(results.get('pkg-a')).to.deep.include({error: 'Deploy failed', errorDetails, status: 'failed'});
    expect(updateValidation).toHaveBeenCalledTimes(1);
    const persisted = updateValidation.mock.calls[0][0] as Record<string, unknown>;
    expect(persisted).to.deep.equal({checks: ['deploy'], error: 'Deploy failed', status: 'failed'});
    expect(persisted).to.not.have.property('errorDetails');
  });
});
