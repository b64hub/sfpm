import {describe, expect, it} from 'vitest';

import type {PackageDefinition} from '../../src/types/project.js';

import {diffPackages} from '../../src/package/package-diff.js';
import {type InstalledArtifact, PackageType} from '../../src/types/package.js';

function projectPackage(overrides: Partial<PackageDefinition> & Pick<PackageDefinition, 'name' | 'version'>): PackageDefinition {
  return {path: `packages/${overrides.name}`, type: PackageType.Unlocked, ...overrides};
}

function installed(name: string, version: string): InstalledArtifact {
  return {name, version};
}

describe('diffPackages', () => {
  it('matches a scoped project package to an unscoped installed artifact when versions match', () => {
    const result = diffPackages(
      [projectPackage({name: '@scope/core', version: '1.2.0'})],
      [installed('core', '1.2.0')],
    );

    expect(result).toEqual([
      {
        name: 'core', orgVersion: '1.2.0', projectVersion: '1.2.0', status: 'match',
      },
    ]);
  });

  it('treats a 4-part org build number as matching the project semver', () => {
    const result = diffPackages(
      [projectPackage({name: 'core', version: '1.2.0'})],
      [installed('core', '1.2.0.7')],
    );

    expect(result[0].status).toBe('match');
  });

  it('reports version-mismatch when major.minor.patch differ', () => {
    const result = diffPackages(
      [projectPackage({name: 'core', version: '1.2.0'})],
      [installed('core', '1.3.0.1')],
    );

    expect(result).toEqual([
      {
        name: 'core', orgVersion: '1.3.0.1', projectVersion: '1.2.0', status: 'version-mismatch',
      },
    ]);
  });

  it('reports not-installed for a project package with no installed artifact', () => {
    const result = diffPackages([projectPackage({name: 'core', version: '1.0.0'})], []);

    expect(result).toEqual([{name: 'core', projectVersion: '1.0.0', status: 'not-installed'}]);
  });

  it('reports not-in-project for an installed artifact with no project package', () => {
    const result = diffPackages([], [installed('orphan', '2.0.0.1')]);

    expect(result).toEqual([{name: 'orphan', orgVersion: '2.0.0.1', status: 'not-in-project'}]);
  });

  it('excludes data packages entirely', () => {
    const result = diffPackages(
      [projectPackage({name: 'seed-data', type: PackageType.Data, version: '1.0.0'})],
      [],
    );

    expect(result).toEqual([]);
  });

  it('excludes a data package even when sfpm reports it as an installed artifact', () => {
    const result = diffPackages(
      [projectPackage({name: 'seed-data', type: PackageType.Data, version: '1.0.0'})],
      [installed('seed-data', '1.0.0')],
    );

    expect(result).toEqual([]);
  });

  it('keeps only the first installed artifact when stripped names collide', () => {
    const result = diffPackages(
      [projectPackage({name: 'core', version: '1.0.0'})],
      [installed('@scope/core', '1.0.0.1'), installed('core', '9.9.9.9')],
    );

    expect(result).toEqual([
      {
        name: 'core', orgVersion: '1.0.0.1', projectVersion: '1.0.0', status: 'match',
      },
    ]);
  });
});
