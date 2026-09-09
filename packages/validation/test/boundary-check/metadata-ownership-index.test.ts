import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ComponentSet} from '@salesforce/source-deploy-retrieve';

import {buildOwnershipIndex, type PackageManifest} from '../../src/boundary-check/metadata-ownership-index.js';

vi.mock('@salesforce/source-deploy-retrieve', () => ({
  ComponentSet: {
    fromSource: vi.fn(),
  },
}));

type MockSourceComponent = {
  fullName: string;
  type: {id: string};
  walkContent: () => string[];
  xml?: string;
};

function component(fullName: string, typeId: string, xml?: string): MockSourceComponent {
  return {
    fullName,
    type: {id: typeId},
    walkContent: () => [],
    xml,
  };
}

function createComponentSet(components: MockSourceComponent[]) {
  return {
    getSourceComponents: () => components,
  };
}

function manifest(packageId: string, packagePath: string): PackageManifest {
  return {declaredDependencies: new Set(), packageId, packagePath};
}

describe('buildOwnershipIndex', () => {
  const mockFromSource = vi.mocked(ComponentSet.fromSource);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers a component and resolves it to its owning package', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([component('MyService', 'apexclass', 'MyService.cls')]) as never,
    );

    const index = buildOwnershipIndex([manifest('pkg-one', '/workspace/force-app')]);

    expect(mockFromSource).toHaveBeenCalledWith('/workspace/force-app');
    expect(index.get('myservice')).toEqual({
      fileName: 'MyService',
      filePath: 'MyService.cls',
      metadataName: 'myservice',
      metadataType: 'ApexClass',
      packageId: 'pkg-one',
    });
  });

  it('index keys are lowercased, so lookups work regardless of the source name\'s casing', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([component('MyService', 'apexclass')]) as never,
    );

    const index = buildOwnershipIndex([manifest('pkg-one', '/workspace/force-app')]);

    expect(index.get('myservice')?.packageId).toBe('pkg-one');
    expect(index.get('MYSERVICE')).toBeUndefined(); // Map keys are exact; only the lowercased form was stored.
  });

  it('only maps types present in SDR_TO_METADATA_TYPE; unmapped types are skipped', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        component('MyService', 'apexclass'),
        component('MyTrigger', 'apextrigger'),
        component('Account', 'customobject'),
        component('My_Flow', 'flow'),
        component('myComponent', 'lightningcomponentbundle'),
      ]) as never,
    );

    const index = buildOwnershipIndex([manifest('pkg-one', 'force-app')]);

    expect(index.get('myservice')?.metadataType).toBe('ApexClass');
    expect(index.get('mytrigger')?.metadataType).toBe('ApexTrigger');
    expect(index.get('account')?.metadataType).toBe('SObject');
    expect(index.get('my_flow')?.metadataType).toBe('Flow');
    expect(index.get('mycomponent')).toBeUndefined();
  });

  it('returns an empty map when no components are found', () => {
    mockFromSource.mockReturnValue(createComponentSet([]) as never);

    const index = buildOwnershipIndex([manifest('pkg-one', 'force-app')]);

    expect(index.size).toBe(0);
  });

  it('reports the correct size, counting only mapped types', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        component('MyService', 'apexclass'),
        component('MyHelper', 'apexclass'),
        component('MyTrigger', 'apextrigger'),
        component('Account', 'customobject'),
        component('Unmapped', 'lightningcomponentbundle'),
      ]) as never,
    );

    const index = buildOwnershipIndex([manifest('pkg-one', 'force-app')]);

    expect(index.size).toBe(4);
  });

  it('resolves components across multiple manifests to their correct owning package', () => {
    mockFromSource
      .mockReturnValueOnce(
        createComponentSet([
          component('MyService', 'apexclass'),
          component('AccountTrigger', 'apextrigger'),
        ]) as never,
      )
      .mockReturnValueOnce(
        createComponentSet([component('MyUtility', 'apexclass')]) as never,
      );

    const index = buildOwnershipIndex([
      manifest('pkg-one', '/workspace/pkg-one'),
      manifest('pkg-two', '/workspace/pkg-two'),
    ]);

    expect(index.get('myservice')?.packageId).toBe('pkg-one');
    expect(index.get('accounttrigger')?.packageId).toBe('pkg-one');
    expect(index.get('myutility')?.packageId).toBe('pkg-two');
    expect(index.size).toBe(3);
  });

  // NOTE: buildOwnershipIndex has no try/catch around ComponentSet.fromSource(),
  // unlike the superseded SymbolRegistry.registerPackage(), which caught errors
  // per-package and continued. Here, a throw from one manifest aborts the whole
  // call — later manifests are never processed. This is a real behavior
  // difference from the old class, not a test gap; flagged for a separate
  // decision on whether per-manifest error isolation should be added.
  it('propagates an error from ComponentSet.fromSource() instead of skipping the manifest (documents current, non-graceful behavior)', () => {
    mockFromSource.mockImplementationOnce(() => {
      throw new Error('boom');
    });

    expect(() => buildOwnershipIndex([manifest('pkg-one', 'force-app')])).toThrow('boom');
  });
});
