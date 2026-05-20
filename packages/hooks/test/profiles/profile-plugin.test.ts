import {describe, it, expect, vi, beforeEach, afterEach} from 'vitest';
import {join} from 'node:path';
import {mkdirSync, rmSync, writeFileSync} from 'node:fs';
import {readFile} from 'node:fs/promises';

import {Connection, Org} from '@salesforce/core';
import type {HookContext} from '@b64hub/sfpm-core';

import {profileHooks} from '../../src/profiles/profile-plugin.js';
import {parseProfileXml} from '../../src/profiles/profile-xml.js';

const profileTestRoot = join(process.cwd(), 'packages', 'hooks', 'test', '.scratch', 'profiles');

function createLogger() {
  return {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
  };
}

function createPackage(overrides?: Partial<HookContext['sfpmPackage']>): HookContext['sfpmPackage'] {
  return {
    name: 'test-package',
    packageDefinition: {},
    packageDirectory: '/project/packages/test-package',
    type: 'Source',
    ...overrides,
  } as HookContext['sfpmPackage'];
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    projectDir: '/project',
    sfpmPackage: createPackage(),
    stage: 'local',
    timing: 'pre',
    ...overrides,
  };
}

function createTestDir(prefix: string): string {
  return join(profileTestRoot, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe('profileHooks', () => {
  it('should return valid LifecycleHooks', () => {
    const hooks = profileHooks();

    expect(hooks.name).toBe('profiles');
    expect(hooks.hooks).toBeDefined();
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('pre');
    expect(hooks.hooks[0].handler).toBeTypeOf('function');
  });

  it('should accept custom options', () => {
    const hooks = profileHooks({
      scope: 'none',
      removeLoginIpRanges: true,
    });

    expect(hooks.name).toBe('profiles');
    expect(hooks.hooks).toHaveLength(1);
  });

  it('should skip when no package path is available', async () => {
    const hooks = profileHooks();
    const handler = hooks.hooks[0].handler;
    const logger = createLogger();
    const context = createContext({
      logger,
      sfpmPackage: createPackage({packageDirectory: undefined}),
    });

    await handler(context);

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no package path'),
    );
  });

  it('should skip when no profiles directory exists', async () => {
    const testDir = createTestDir('sfpm-plugin-test');
    mkdirSync(testDir, {recursive: true});

    try {
      const hooks = profileHooks();
      const handler = hooks.hooks[0].handler;
      const logger = createLogger();
      const context = createContext({
        logger,
        sfpmPackage: createPackage({packageDirectory: testDir}),
      });

      await handler(context);

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('no profiles directory'),
      );
    } finally {
      rmSync(testDir, {recursive: true, force: true});
    }
  });

  describe('end-to-end hook execution', () => {
    let testDir: string;

    beforeEach(() => {
      testDir = createTestDir('sfpm-plugin-e2e');
      mkdirSync(testDir, {recursive: true});
    });

    afterEach(() => {
      rmSync(testDir, {recursive: true, force: true});
    });

    it('should clean profiles during install:pre hook', async () => {
      const profilesDir = join(testDir, 'profiles');
      const classesDir = join(testDir, 'classes');
      mkdirSync(profilesDir, {recursive: true});
      mkdirSync(classesDir, {recursive: true});

      writeFileSync(join(classesDir, 'MyController.cls-meta.xml'), '<ApexClass/>');

      writeFileSync(join(profilesDir, 'Admin.profile-meta.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OldController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
    <loginIpRanges>
        <endAddress>255.255.255.255</endAddress>
        <startAddress>0.0.0.0</startAddress>
    </loginIpRanges>
</Profile>`);

      const hooks = profileHooks({scope: 'source', removeLoginIpRanges: true});
      const handler = hooks.hooks[0].handler;
      const logger = createLogger();

      await handler(createContext({
        logger,
        sfpmPackage: createPackage({packageDirectory: testDir}),
      }));

      const content = await readFile(join(profilesDir, 'Admin.profile-meta.xml'), 'utf-8');
      const profile = parseProfileXml(content);

      expect(profile.classAccesses).toHaveLength(1);
      expect(profile.classAccesses![0].apexClass).toBe('MyController');
      expect(profile.loginIpRanges).toBeUndefined();

      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cleaning profiles'));
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('cleaned 1 profile'));
    });

    it('should use org resolver when targetOrg is in context', async () => {
      const profilesDir = join(testDir, 'profiles');
      const classesDir = join(testDir, 'classes');
      mkdirSync(profilesDir, {recursive: true});
      mkdirSync(classesDir, {recursive: true});

      writeFileSync(join(classesDir, 'MyController.cls-meta.xml'), '<ApexClass/>');

      writeFileSync(join(profilesDir, 'Admin.profile-meta.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OrgOnlyClass</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>DeletedClass</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
</Profile>`);

      const mockConnection = Object.create(Connection.prototype) as Connection;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockConnection as any).query = vi.fn().mockResolvedValue({records: []});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockConnection as any).describeGlobal = vi.fn().mockResolvedValue({sobjects: []});
      Object.defineProperty(mockConnection, 'metadata', {
        value: {list: vi.fn().mockResolvedValue([{fullName: 'OrgOnlyClass'}])},
        writable: true,
      });

      const mockOrg = Object.create(Org.prototype) as Org;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockOrg as any).getConnection = vi.fn().mockReturnValue(mockConnection);

      vi.spyOn(Org, 'create').mockResolvedValue(mockOrg);

      const hooks = profileHooks({scope: 'org'});
      const handler = hooks.hooks[0].handler;
      const logger = createLogger();

      await handler(createContext({
        logger,
        sfpmPackage: createPackage({packageDirectory: testDir}),
        targetOrg: 'test@user.org',
      }));

      const content = await readFile(join(profilesDir, 'Admin.profile-meta.xml'), 'utf-8');
      const profile = parseProfileXml(content);

      expect(profile.classAccesses).toHaveLength(2);
      const names = profile.classAccesses!.map((c) => c.apexClass);
      expect(names).toContain('MyController');
      expect(names).toContain('OrgOnlyClass');
      expect(names).not.toContain('DeletedClass');

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('org connection available'),
      );
    });

    it('should resolve org metadata from targetOrg', async () => {
      const profilesDir = join(testDir, 'profiles');
      const classesDir = join(testDir, 'classes');
      mkdirSync(profilesDir, {recursive: true});
      mkdirSync(classesDir, {recursive: true});

      writeFileSync(join(classesDir, 'MyController.cls-meta.xml'), '<ApexClass/>');

      writeFileSync(join(profilesDir, 'Admin.profile-meta.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>ResolverClass</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
</Profile>`);

      const mockConnection = Object.create(Connection.prototype) as Connection;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockConnection as any).query = vi.fn().mockResolvedValue({records: []});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockConnection as any).describeGlobal = vi.fn().mockResolvedValue({sobjects: []});
      Object.defineProperty(mockConnection, 'metadata', {
        value: {list: vi.fn().mockResolvedValue([{fullName: 'ResolverClass'}])},
        writable: true,
      });

      const mockOrg = Object.create(Org.prototype) as Org;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (mockOrg as any).getConnection = vi.fn().mockReturnValue(mockConnection);

      vi.spyOn(Org, 'create').mockResolvedValue(mockOrg);

      const hooks = profileHooks({scope: 'org'});
      const handler = hooks.hooks[0].handler;
      const logger = createLogger();

      await handler(createContext({
        logger,
        sfpmPackage: createPackage({packageDirectory: testDir}),
        targetOrg: 'test@user.org',
      }));

      const content = await readFile(join(profilesDir, 'Admin.profile-meta.xml'), 'utf-8');
      const profile = parseProfileXml(content);

      expect(profile.classAccesses).toHaveLength(2);
    });

    it('should fall back to source-only when no org connection', async () => {
      const profilesDir = join(testDir, 'profiles');
      const classesDir = join(testDir, 'classes');
      mkdirSync(profilesDir, {recursive: true});
      mkdirSync(classesDir, {recursive: true});

      writeFileSync(join(classesDir, 'MyController.cls-meta.xml'), '<ApexClass/>');

      writeFileSync(join(profilesDir, 'Admin.profile-meta.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>MyController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OtherClass</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <custom>true</custom>
</Profile>`);

      const hooks = profileHooks({scope: 'source'});
      const handler = hooks.hooks[0].handler;
      const logger = createLogger();

      await handler(createContext({
        logger,
        sfpmPackage: createPackage({packageDirectory: testDir}),
      }));

      const content = await readFile(join(profilesDir, 'Admin.profile-meta.xml'), 'utf-8');
      const profile = parseProfileXml(content);

      expect(profile.classAccesses).toHaveLength(1);
      expect(profile.classAccesses![0].apexClass).toBe('MyController');

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('source only'),
      );
    });
  });
});
