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
    expect(orch.start).toBe('orchestration:start');
    expect(orch.end).toBe('orchestration:complete');

    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;
    expect(build.start).toBe('build:start');
    expect(build.end).toBe('build:complete');

    const install = defaultSpanMappings.find(m => m.name === 'sfpm.install')!;
    expect(install.start).toBe('install:start');
    expect(install.end).toBe('install:complete');
  });

  it('should generate unique span keys per instance', () => {
    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;

    const key1 = build.spanKey({orchestrationId: 'orch-1', packageName: 'pkg-a'});
    const key2 = build.spanKey({orchestrationId: 'orch-1', packageName: 'pkg-b'});
    const key3 = build.spanKey({orchestrationId: 'orch-2', packageName: 'pkg-a'});

    expect(key1).not.toBe(key2);
    expect(key1).not.toBe(key3);
    expect(key2).not.toBe(key3);
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

  it('should resolve parent key for build spans', () => {
    const build = defaultSpanMappings.find(m => m.name === 'sfpm.build')!;

    const parentKey = build.parentKey!({orchestrationId: 'orch-1'});
    expect(parentKey).toBe('orchestration:orch-1');

    const noParent = build.parentKey!({});
    expect(noParent).toBeUndefined();
  });

  it('should not have parentKey for orchestration spans', () => {
    const orch = defaultSpanMappings.find(m => m.name === 'sfpm.orchestration')!;
    expect(orch.parentKey).toBeUndefined();
  });
});
