import {describe, expect, it} from 'vitest';

import {toPackageDefinition, toWorkspacePackageJson} from '../../../src/project/providers/workspace-adapter.js';
import type {PackageDefinition, ProjectDefinition} from '../../../src/types/project.js';
import type {WorkspacePackageJson} from '../../../src/project/providers/types/workspace.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeWorkspacePackageJson(overrides?: Partial<WorkspacePackageJson>): WorkspacePackageJson {
  return {
    dependencies: {
      '@myorg/utils': 'workspace:^1.0.0',
    },
    name: '@myorg/core',
    sfpm: {
      packageId: '0HoAAAAAAAAAAAA',
      packageType: 'unlocked',
      path: 'force-app',
    },
    version: '1.2.0',
    ...overrides,
  };
}

function makeWorkspaceVersions(): Map<string, string> {
  return new Map([
    ['@myorg/core', '1.2.0'],
    ['@myorg/utils', '1.0.0'],
  ]);
}

// ---------------------------------------------------------------------------
// toPackageDefinition
// ---------------------------------------------------------------------------

describe('toPackageDefinition', () => {
  it('maps basic fields from workspace package.json', () => {
    const result = toPackageDefinition(makeWorkspacePackageJson(), 'packages/core');

    expect(result.name).toBe('@myorg/core');
    expect(result.version).toBe('1.2.0');
    expect(result.type).toBe('unlocked');
    expect(result.path).toBe('packages/core/force-app');
  });

  it('preserves packageId from sfpm config', () => {
    const result = toPackageDefinition(makeWorkspacePackageJson(), 'packages/core');
    expect(result.packageId).toBe('0HoAAAAAAAAAAAA');
  });

  it('resolves workspace dependencies using version map', () => {
    const result = toPackageDefinition(
      makeWorkspacePackageJson(),
      'packages/core',
      makeWorkspaceVersions(),
    );

    expect(result.dependencies).toBeDefined();
    expect(result.dependencies!['@myorg/utils']).toBe('^1.0.0');
  });

  it('uses path "." when sfpm.path is not set', () => {
    const pkgJson = makeWorkspacePackageJson();
    delete (pkgJson.sfpm as any).path;

    const result = toPackageDefinition(pkgJson, 'packages/core');
    expect(result.path).toBe('packages/core');
  });

  it('copies managedDependencies from package.json', () => {
    const pkgJson = makeWorkspacePackageJson({
      managedDependencies: {'nebula-logger': '04tXXXXXXXXXXXXX'},
    });

    const result = toPackageDefinition(pkgJson, 'packages/core');
    expect(result.managedDependencies).toEqual({'nebula-logger': '04tXXXXXXXXXXXXX'});
  });

  it('resolves metadataDependencies paths relative to package dir', () => {
    const pkgJson = makeWorkspacePackageJson({
      metadataDependencies: {seed: 'seed-meta', unpackaged: 'unpackaged-meta'},
    });

    const result = toPackageDefinition(pkgJson, 'packages/core');
    expect(result.metadataDependencies).toEqual({
      seed: 'packages/core/seed-meta',
      unpackaged: 'packages/core/unpackaged-meta',
    });
  });

  it('includes description when present', () => {
    const pkgJson = makeWorkspacePackageJson({description: 'Core package'});
    const result = toPackageDefinition(pkgJson, 'packages/core');
    expect(result.description).toBe('Core package');
  });
});

// ---------------------------------------------------------------------------
// toWorkspacePackageJson
// ---------------------------------------------------------------------------

describe('toWorkspacePackageJson', () => {
  const projectDef: ProjectDefinition = {
    packages: [
      {name: 'core', path: 'packages/core/force-app', type: 'unlocked', version: '1.2.0'},
      {name: 'utils', path: 'packages/utils/force-app', type: 'unlocked', version: '1.0.0'},
    ],
  };

  it('maps basic fields to workspace package.json', () => {
    const pkgDef: PackageDefinition = {
      name: 'core',
      path: 'packages/core/force-app',
      type: 'unlocked',
      version: '1.2.0',
    };

    const result = toWorkspacePackageJson(
      pkgDef, 'packages/core', 'force-app', 'unlocked',
      {npmScope: '@myorg'}, projectDef,
    );

    expect(result.name).toBe('@myorg/core');
    expect(result.version).toBe('1.2.0');
    expect(result.sfpm.packageType).toBe('unlocked');
    expect(result.sfpm.path).toBe('force-app');
    expect(result.private).toBe(true);
  });

  it('omits sfpm.path when source path is "."', () => {
    const pkgDef: PackageDefinition = {
      name: 'data',
      path: 'packages/data',
      type: 'source',
      version: '1.0.0',
    };

    const result = toWorkspacePackageJson(
      pkgDef, 'packages/data', '.', 'source',
      {npmScope: '@myorg'}, projectDef,
    );

    expect(result.sfpm.path).toBeUndefined();
  });

  it('converts internal dependencies to workspace: protocol', () => {
    const pkgDef: PackageDefinition = {
      dependencies: {utils: '^1.0.0'},
      name: 'core',
      path: 'packages/core/force-app',
      type: 'unlocked',
      version: '1.2.0',
    };

    const result = toWorkspacePackageJson(
      pkgDef, 'packages/core', 'force-app', 'unlocked',
      {npmScope: '@myorg'}, projectDef,
    );

    expect(result.dependencies).toBeDefined();
    expect(result.dependencies!['@myorg/utils']).toBe('workspace:^1.0.0');
  });

  it('includes managedDependencies when present', () => {
    const pkgDef: PackageDefinition = {
      managedDependencies: {'nebula-logger': '04tXXX'},
      name: 'core',
      path: 'packages/core/force-app',
      type: 'unlocked',
      version: '1.2.0',
    };

    const result = toWorkspacePackageJson(
      pkgDef, 'packages/core', 'force-app', 'unlocked',
      {npmScope: '@myorg'}, projectDef,
    );

    expect(result.managedDependencies).toEqual({'nebula-logger': '04tXXX'});
  });

  it('preserves packageId in sfpm config', () => {
    const pkgDef: PackageDefinition = {
      name: 'core',
      packageId: '0HoAAAAAAAAAAAA',
      path: 'packages/core/force-app',
      type: 'unlocked',
      version: '1.2.0',
    };

    const result = toWorkspacePackageJson(
      pkgDef, 'packages/core', 'force-app', 'unlocked',
      {npmScope: '@myorg'}, projectDef,
    );

    expect(result.sfpm.packageId).toBe('0HoAAAAAAAAAAAA');
  });
});
