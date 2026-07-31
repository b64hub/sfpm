import { describe, expect, it, vi } from 'vitest';
import type { NimbusClassGraph } from '../../src/ports/dependency-graph.js';
import type { PackageManifest } from '../../src/boundary-check/metadata-ownership-index.js';
import { buildOwnershipIndex } from '../../src/boundary-check/metadata-ownership-index.js';
import { findPackageBoundaryViolations } from '../../src/boundary-check/find-boundary-violations.js';

// Hand-rolled fake graph provider — returns canned graphs keyed by class name.
function fakeProvider(graphs: Record<string, Partial<NimbusClassGraph>>) {
  return {
    getMetadataDependencies: vi.fn(async (metadataName: string) => ({
      class: metadataName,
      dependencies: [],
      direct_dependents: [],
      test_dependents: [],
      transitive_dependents: [],
      limits: [],
      ...graphs[metadataName],
    })),
  };
}

const CTX = { projectRoot: '/project', packageId: 'pkg-a' };

// Manifests used across multiple tests
const PKG_A: PackageManifest = {
  packageId: 'pkg-a',
  ownedFiles: new Set(['/project/pkg-a/ServiceA.cls']),
  declaredDependencies: new Set(['pkg-b']),
};
const PKG_B: PackageManifest = {
  packageId: 'pkg-b',
  ownedFiles: new Set(['/project/pkg-b/ServiceB.cls']),
  declaredDependencies: new Set(),
};
const PKG_C: PackageManifest = {
  packageId: 'pkg-c',
  ownedFiles: new Set(['/project/pkg-c/ServiceC.cls']),
  declaredDependencies: new Set(),
};

describe('findPackageBoundaryViolations', () => {
  it('no violation when dependency is in a declared-dependency package', async () => {
    const index = buildOwnershipIndex([PKG_A, PKG_B]);
    const provider = fakeProvider({ servicea: { dependencies: ['serviceb'] } });

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
  });

  it('one violation when dependency is in an undeclared package', async () => {
    const index = buildOwnershipIndex([PKG_A, PKG_B, PKG_C]);
    const provider = fakeProvider({ servicea: { dependencies: ['servicec'] } });

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(1);
    const v = result.violations[0];
    expect(v.fromPackage).toBe('pkg-a');
    expect(v.toPackage).toBe('pkg-c');
    expect(v.fromClass).toBe('servicea');
    expect(v.toClass).toBe('servicec');
  });

  it('unresolved when dependency is not in the ownership index (e.g. platform class)', async () => {
    const index = buildOwnershipIndex([PKG_A]);
    const provider = fakeProvider({ servicea: { dependencies: ['system.string'] } });

    const result = await findPackageBoundaryViolations(PKG_A, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.unresolved).toContain('system.string');
  });

  it('deduplicates caveats from multiple classes', async () => {
    const pkgMulti: PackageManifest = {
      packageId: 'pkg-multi',
      ownedFiles: new Set(['/project/pkg-multi/ClassX.cls', '/project/pkg-multi/ClassY.cls']),
      declaredDependencies: new Set(),
    };
    const index = buildOwnershipIndex([pkgMulti]);
    const provider = fakeProvider({
      classx: { limits: ['soql-limit-reached'] },
      classy: { limits: ['soql-limit-reached', 'heap-limit'] },
    });

    const result = await findPackageBoundaryViolations(pkgMulti, index, provider, CTX);

    // 'soql-limit-reached' appears in both classes — should be deduplicated
    expect(result.caveats).toHaveLength(2);
    expect(result.caveats).toContain('soql-limit-reached');
    expect(result.caveats).toContain('heap-limit');
  });

  it('self-package dependencies never produce violations', async () => {
    const index = buildOwnershipIndex([PKG_A]);
    // ServiceA depends on another class also owned by pkg-a (not in the index here, just missing)
    // Even if we add another pkg-a class, it should not violate
    const pkgASelf: PackageManifest = {
      packageId: 'pkg-a',
      ownedFiles: new Set(['/project/pkg-a/ServiceA.cls', '/project/pkg-a/HelperA.cls']),
      declaredDependencies: new Set(),
    };
    const indexSelf = buildOwnershipIndex([pkgASelf]);
    const provider = fakeProvider({ servicea: { dependencies: ['helpera'] } });

    const result = await findPackageBoundaryViolations(pkgASelf, indexSelf, provider, CTX);

    expect(result.violations).toHaveLength(0);
  });

  it('empty ownedFiles produces empty result without errors', async () => {
    const emptyPkg: PackageManifest = {
      packageId: 'empty-pkg',
      ownedFiles: new Set(),
      declaredDependencies: new Set(),
    };
    const index = buildOwnershipIndex([emptyPkg]);
    const provider = fakeProvider({});

    const result = await findPackageBoundaryViolations(emptyPkg, index, provider, CTX);

    expect(result.violations).toHaveLength(0);
    expect(result.caveats).toHaveLength(0);
    expect(result.unresolved).toHaveLength(0);
    expect(provider.getMetadataDependencies).not.toHaveBeenCalled();
  });
});
