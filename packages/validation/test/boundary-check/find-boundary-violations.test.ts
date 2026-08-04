import { describe, expect, it, vi } from 'vitest';
import type { DependencyGraphNode, MetadataRef } from '../../src/types/dependency-graph.js';
import type { MetadataOwnership, PackageManifest } from '../../src/boundary-check/metadata-ownership-index.js';
import { findPackageBoundaryViolations } from '../../src/boundary-check/find-boundary-violations.js';

const CTX = { projectRoot: '/project', packageId: 'pkg-a' };

// Build an ownership map directly, bypassing SDR, for unit tests.
function makeIndex(entries: Array<{ name: string; packageId: string }>): Map<string, MetadataOwnership> {
  return new Map(entries.map(({name, packageId}) => [
    name.toLowerCase(),
    {
      fileName:     name,
      filePath:     `/project/${packageId}/${name}.cls`,
      metadataName: name.toLowerCase(),
      metadataType: 'ApexClass' as const,
      packageId,
    },
  ]));
}

// Fake provider: returns a DependencyGraphNode with outbound 'calls' edges for each dep name.
function fakeProvider(graphs: Record<string, string[]>) {
  return {
    getMetadataDependencies: vi.fn(async (ref: MetadataRef): Promise<DependencyGraphNode> => {
      const deps = graphs[ref.name.toLowerCase()] ?? [];
      return {
        caveats:      [],
        coverage:     {hasRun: false, recordedAt: null, stale: null},
        details:      {metadataType: 'ApexClass', isTest: false},
        edges:        deps.map(name => ({
          confidence:  'static' as const,
          direction:   'outbound' as const,
          relation:    'calls' as const,
          target:      {name, type: 'ApexClass' as const},
          testContext: false,
          transitive:  false,
        })),
        metadataName: ref.name,
        metadataType: 'ApexClass',
      };
    }),
  };
}

const PKG_A: PackageManifest = {packageId: 'pkg-a', packagePath: '/project/pkg-a', declaredDependencies: new Set(['pkg-b'])};
const PKG_B: PackageManifest = {packageId: 'pkg-b', packagePath: '/project/pkg-b', declaredDependencies: new Set()};
const PKG_C: PackageManifest = {packageId: 'pkg-c', packagePath: '/project/pkg-c', declaredDependencies: new Set()};

describe('findPackageBoundaryViolations', () => {
  it('no violation when dependency is in a declared-dependency package', async () => {
    const index = makeIndex([{name: 'ServiceA', packageId: 'pkg-a'}, {name: 'ServiceB', packageId: 'pkg-b'}]);
    const provider = fakeProvider({servicea: ['ServiceB']});

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
  });

  it('one violation when dependency is in an undeclared package', async () => {
    const index = makeIndex([
      {name: 'ServiceA', packageId: 'pkg-a'},
      {name: 'ServiceB', packageId: 'pkg-b'},
      {name: 'ServiceC', packageId: 'pkg-c'},
    ]);
    const provider = fakeProvider({servicea: ['ServiceC']});

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v.fromPackage).toBe('pkg-a');
    expect(v.toPackage).toBe('pkg-c');
    expect(v.fromMetadata).toBe('ServiceA');
    expect(v.toMetadata).toBe('ServiceC');
  });

  it('unresolved when dependency is not in the ownership index (e.g. platform class)', async () => {
    const index = makeIndex([{name: 'ServiceA', packageId: 'pkg-a'}]);
    const provider = fakeProvider({servicea: ['System.String']});

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.unresolved).toContain('system.string');
  });

  it('deduplicates caveats from multiple classes', async () => {
    const index = makeIndex([
      {name: 'ClassX', packageId: 'pkg-multi'},
      {name: 'ClassY', packageId: 'pkg-multi'},
    ]);
    const pkgMulti: PackageManifest = {packageId: 'pkg-multi', packagePath: '/project/pkg-multi', declaredDependencies: new Set()};
    const provider: ReturnType<typeof fakeProvider> = {
      getMetadataDependencies: vi.fn(async (ref: MetadataRef): Promise<DependencyGraphNode> => ({
        caveats:      [{code: 'dynamic-soql-not-read'}],
        coverage:     {hasRun: false, recordedAt: null, stale: null},
        details:      {metadataType: 'ApexClass', isTest: false},
        edges:        [],
        metadataName: ref.name,
        metadataType: 'ApexClass',
      })),
    };

    const result = await findPackageBoundaryViolations(pkgMulti, index, provider, CTX);

    // Same caveat from two classes — deduplicated to one
    expect(result.caveats).toHaveLength(1);
    expect(result.caveats[0]).toBe('dynamic-soql-not-read');
  });

  it('self-package dependencies never produce violations', async () => {
    const index = makeIndex([
      {name: 'ServiceA', packageId: 'pkg-a'},
      {name: 'HelperA',  packageId: 'pkg-a'},
    ]);
    const provider = fakeProvider({servicea: ['HelperA']});

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
  });

  it('empty owned metadata produces empty result without calling provider', async () => {
    const index = makeIndex([{name: 'ServiceB', packageId: 'pkg-b'}]); // pkg-a owns nothing
    const provider = fakeProvider({});

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.caveats).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(provider.getMetadataDependencies).not.toHaveBeenCalled();
  });
});
