import {describe, it, expect, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';

import {ProfileCleaner, findProfilesDirectory} from '../src/profile-cleaner.js';

describe('ProfileCleaner', () => {
  it('should initialize with default options', () => {
    const cleaner = new ProfileCleaner();
    expect(cleaner.options.reconcile).toBe(true);
    expect(cleaner.options.removeLoginIpRanges).toBe(false);
    expect(cleaner.options.removeLoginHours).toBe(false);
    expect(cleaner.options.removeUnassignedUserPermissions).toBe(false);
  });

  it('should accept custom options', () => {
    const cleaner = new ProfileCleaner({
      reconcile: false,
      removeLoginIpRanges: true,
    });
    expect(cleaner.options.reconcile).toBe(false);
    expect(cleaner.options.removeLoginIpRanges).toBe(true);
  });

  it('should return early for nonexistent directory', async () => {
    const cleaner = new ProfileCleaner();
    const result = await cleaner.cleanProfiles('/nonexistent/path');
    expect(result).toBeUndefined();
  });
});

describe('findProfilesDirectory', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `sfpm-profile-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, {recursive: true});
  });

  afterEach(() => {
    rmSync(testDir, {recursive: true, force: true});
  });

  it('should find profiles directory at package root', () => {
    const profilesDir = join(testDir, 'profiles');
    mkdirSync(profilesDir);

    expect(findProfilesDirectory(testDir)).toBe(profilesDir);
  });

  it('should find profiles in main/default/profiles', () => {
    const profilesDir = join(testDir, 'main', 'default', 'profiles');
    mkdirSync(profilesDir, {recursive: true});

    expect(findProfilesDirectory(testDir)).toBe(profilesDir);
  });

  it('should return undefined when no profiles directory exists', () => {
    expect(findProfilesDirectory(testDir)).toBeUndefined();
  });

  it('should prefer root-level profiles directory', () => {
    const rootProfiles = join(testDir, 'profiles');
    mkdirSync(rootProfiles);
    mkdirSync(join(testDir, 'main', 'default', 'profiles'), {recursive: true});

    expect(findProfilesDirectory(testDir)).toBe(rootProfiles);
  });
});
