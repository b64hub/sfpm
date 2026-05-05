import {describe, expect, it} from 'vitest';

import {fromSalesforceProjectJson, toSalesforceProjectJson} from '../../../src/project/providers/sfdx-project-adapter.js';
import type {PackageDefinition, ProjectDefinition} from '../../../src/types/project.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDefinition(overrides?: Partial<ProjectDefinition>): ProjectDefinition {
  return {
    packages: [
      {
        dependencies: {'@myorg/utils': '^1.0.0'},
        managedDependencies: {'nebula-logger': '04tXXXXXXXXXXXXX'},
        name: '@myorg/core',
        packageId: '0HoAAAAAAAAAAAA',
        packageOptions: {default: true},
        path: 'packages/core/force-app',
        type: 'unlocked',
        version: '1.2.0',
      },
      {
        name: '@myorg/utils',
        path: 'packages/utils/force-app',
        type: 'unlocked',
        version: '1.0.0',
      },
      {
        name: '@myorg/data',
        path: 'packages/data',
        type: 'source',
        version: '1.0.0',
      },
    ],
    sourceApiVersion: '63.0',
    ...overrides,
  };
}

function makeSfdxProjectJson(): Record<string, unknown> {
  return {
    packageAliases: {
      core: '0HoAAAAAAAAAAAA',
      'nebula-logger': '04tXXXXXXXXXXXXX',
    },
    packageDirectories: [
      {
        default: true,
        dependencies: [
          {package: 'utils', versionNumber: '1.0.0.LATEST'},
          {package: 'nebula-logger'},
        ],
        package: 'core',
        path: 'packages/core/force-app',
        type: 'unlocked',
        versionNumber: '1.2.0.NEXT',
      },
      {
        package: 'utils',
        path: 'packages/utils/force-app',
        type: 'unlocked',
        versionNumber: '1.0.0.NEXT',
      },
      {
        package: 'data',
        path: 'packages/data',
        type: 'source',
        versionNumber: '1.0.0.0',
      },
    ],
    sourceApiVersion: '63.0',
  };
}

// ---------------------------------------------------------------------------
// toSalesforceProjectJson
// ---------------------------------------------------------------------------

describe('toSalesforceProjectJson', () => {
  it('maps packages to packageDirectories', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    const dirs = result.packageDirectories as Record<string, unknown>[];

    expect(dirs).toHaveLength(3);
    expect(dirs[0]).toMatchObject({package: 'core', path: 'packages/core/force-app'});
  });

  it('strips npm scope from package names', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    const dirs = result.packageDirectories as Record<string, unknown>[];

    expect(dirs[0]).toHaveProperty('package', 'core');
    expect(dirs[1]).toHaveProperty('package', 'utils');
  });

  it('converts semver to Salesforce version with token', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    const dirs = result.packageDirectories as Record<string, unknown>[];

    // Unlocked packages get .NEXT
    expect(dirs[0]).toHaveProperty('versionNumber', '1.2.0.NEXT');
    // Source packages get .0
    expect(dirs[2]).toHaveProperty('versionNumber', '1.0.0.0');
  });

  it('builds packageAliases from packageId and managedDependencies', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    const aliases = result.packageAliases as Record<string, string>;

    expect(aliases.core).toBe('0HoAAAAAAAAAAAA');
    expect(aliases['nebula-logger']).toBe('04tXXXXXXXXXXXXX');
  });

  it('builds SF dependencies array from workspace deps', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    const dirs = result.packageDirectories as Array<{dependencies?: Array<{package: string; versionNumber?: string}>}>;
    const coreDeps = dirs[0].dependencies!;

    // Workspace dep with version
    const utilsDep = coreDeps.find(d => d.package === 'utils');
    expect(utilsDep).toBeDefined();
    expect(utilsDep?.versionNumber).toBe('1.0.0.LATEST');

    // Managed dep without version
    const nebulaRef = coreDeps.find(d => d.package === 'nebula-logger');
    expect(nebulaRef).toBeDefined();
    expect(nebulaRef?.versionNumber).toBeUndefined();
  });

  it('includes sourceApiVersion in output', () => {
    const result = toSalesforceProjectJson(makeDefinition());
    expect(result.sourceApiVersion).toBe('63.0');
  });

  it('handles metadata dependencies', () => {
    const def = makeDefinition();
    def.packages[0].metadataDependencies = {seed: 'seed-meta', unpackaged: 'unpackaged-meta'};

    const result = toSalesforceProjectJson(def);
    const dirs = result.packageDirectories as Array<Record<string, unknown>>;

    expect(dirs[0].seedMetadata).toEqual({path: 'seed-meta'});
    expect(dirs[0].unpackagedMetadata).toEqual({path: 'unpackaged-meta'});
  });
});

// ---------------------------------------------------------------------------
// fromSalesforceProjectJson
// ---------------------------------------------------------------------------

describe('fromSalesforceProjectJson', () => {
  it('maps packageDirectories to packages', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    expect(result.packages).toHaveLength(3);
  });

  it('converts SF version to semver (strips .NEXT and .0)', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    const core = result.packages.find(p => p.name === 'core')!;
    const data = result.packages.find(p => p.name === 'data')!;

    // .NEXT → base only
    expect(core.version).toBe('1.2.0');
    // .0 → base only
    expect(data.version).toBe('1.0.0');
  });

  it('converts SF version with build number to semver prerelease', () => {
    const sfJson = makeSfdxProjectJson();
    (sfJson.packageDirectories as any[])[0].versionNumber = '1.2.0.5';

    const result = fromSalesforceProjectJson(sfJson);
    expect(result.packages[0].version).toBe('1.2.0-5');
  });

  it('classifies local deps into dependencies record', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    const core = result.packages.find(p => p.name === 'core')!;

    expect(core.dependencies).toBeDefined();
    expect(core.dependencies!.utils).toBe('^1.0.0');
  });

  it('classifies managed deps from packageAliases with 04t prefix', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    const core = result.packages.find(p => p.name === 'core')!;

    expect(core.managedDependencies).toBeDefined();
    expect(core.managedDependencies!['nebula-logger']).toBe('04tXXXXXXXXXXXXX');
  });

  it('maps packageAliases to packageId for local packages', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    const core = result.packages.find(p => p.name === 'core')!;

    expect(core.packageId).toBe('0HoAAAAAAAAAAAA');
  });

  it('preserves sourceApiVersion', () => {
    const result = fromSalesforceProjectJson(makeSfdxProjectJson());
    expect(result.sourceApiVersion).toBe('63.0');
  });

  it('defaults type to unlocked when missing', () => {
    const sfJson = makeSfdxProjectJson();
    delete (sfJson.packageDirectories as any[])[0].type;

    const result = fromSalesforceProjectJson(sfJson);
    expect(result.packages[0].type).toBe('unlocked');
  });

  it('returns empty packages array when packageDirectories is missing', () => {
    const result = fromSalesforceProjectJson({});
    expect(result.packages).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

describe('round-trip conversion', () => {
  it('preserves package names, versions, and dependencies', () => {
    const original = makeDefinition();
    const sfJson = toSalesforceProjectJson(original);
    const roundTripped = fromSalesforceProjectJson(sfJson);

    // Package count preserved
    expect(roundTripped.packages).toHaveLength(original.packages.length);

    // Core package roundtrips
    const core = roundTripped.packages.find(p => p.name === 'core')!;
    expect(core.version).toBe('1.2.0');
    expect(core.packageId).toBe('0HoAAAAAAAAAAAA');
    expect(core.dependencies?.utils).toBe('^1.0.0');
    expect(core.managedDependencies?.['nebula-logger']).toBe('04tXXXXXXXXXXXXX');

    // Source API version
    expect(roundTripped.sourceApiVersion).toBe('63.0');
  });
});
