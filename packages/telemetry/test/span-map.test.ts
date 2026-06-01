import {describe, expect, it} from 'vitest';

import {defaultSpanMappings} from '../src/span-map.js';

describe('defaultSpanMappings', () => {
  it('should have mappings for orchestration, build, and install', () => {
    expect(defaultSpanMappings).toHaveLength(3);

    const names = defaultSpanMappings.map(m => m.name);
    expect(names).toContain('sfpm.orchestration');
    expect(names).toContain('sfpm.build');
    expect(names).toContain('sfpm.install');
  });

  it('should map correct event pairs', () => {
    const orch = defaultSpanMappings.find(m => m.name === 'sfpm.orchestration')!;
    expect(orch.bus).toBe('orchestration');
    expect(orch.start).toBe('start');
    expect(orch.end).toBe('complete');

    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;
    expect(build.bus).toBe('build');
    expect(build.start).toBe('start');
    expect(build.end).toBe('complete');

    const install = defaultSpanMappings.find(m => m.name === 'sfpm.install')!;
    expect(install.bus).toBe('install');
    expect(install.start).toBe('start');
    expect(install.end).toBe('complete');
  });

  it('should generate unique span keys per package', () => {
    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;

    const key1 = build.spanKey({packageName: 'pkg-a'});
    const key2 = build.spanKey({packageName: 'pkg-b'});

    expect(key1).not.toBe(key2);
    expect(key1).toBe('build:pkg-a');
    expect(key2).toBe('build:pkg-b');
  });

  it('should extract orchestration start attributes', () => {
    const orch = defaultSpanMappings.find(m => m.name === 'sfpm.orchestration')!;
    const attrs = orch.startAttributes!({
      includeDependencies: true,
      orchestrationId: 'test-id',
      totalLevels: 3,
      totalPackages: 5,
    });

    expect(attrs).toEqual({
      'sfpm.orchestration.id': 'test-id',
      'sfpm.orchestration.include_dependencies': true,
      'sfpm.orchestration.total_levels': 3,
      'sfpm.orchestration.total_packages': 5,
    });
  });

  it('should extract build start and end attributes', () => {
    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;

    const startAttrs = build.startAttributes!({
      packageName: 'my-pkg',
      packageType: 'unlocked',
    });
    expect(startAttrs).toEqual({
      'sfpm.package.name': 'my-pkg',
      'sfpm.package.type': 'unlocked',
    });

    const endAttrs = build.endAttributes!({
      skipped: false,
      success: true,
    });
    expect(endAttrs).toEqual({
      'sfpm.build.skipped': false,
      'sfpm.build.success': true,
    });
  });

  it('should resolve parent key for build spans to fixed orchestration key', () => {
    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;

    const parentKey = build.parentKey!({packageName: 'pkg-a'});
    expect(parentKey).toBe('orchestration');
  });

  it('should not have parentKey for orchestration spans', () => {
    const orch = defaultSpanMappings.find(m => m.name === 'sfpm.orchestration')!;
    expect(orch.parentKey).toBeUndefined();
  });
});
