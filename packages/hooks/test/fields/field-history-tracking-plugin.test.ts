import {
  describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {fieldHistoryTrackingHooks} from '../../src/fields/field-history-tracking-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../src/fields/field-tracking-enabler.js', () => ({
  FieldTrackingEnabler: vi.fn().mockImplementation(function() { return {
    enableTracking: vi.fn().mockResolvedValue({fieldsEnabled: 0, fieldsSkipped: 0, success: true}),
  }; }),
}));

import {FieldTrackingEnabler} from '../../src/fields/field-tracking-enabler.js';

// ============================================================================
// Test Helpers
// ============================================================================

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

function createMockOrg(options?: {isScratch?: boolean}) {
  const connection = {query: vi.fn(), metadata: {read: vi.fn(), update: vi.fn()}};
  const org = Object.create(Org.prototype);
  org.getConnection = vi.fn().mockReturnValue(connection);
  org.determineIfScratch = vi.fn().mockResolvedValue(options?.isScratch ?? false);
  return org as Org;
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    packageName: 'test-package',
    packageType: 'Source',
    timing: 'post',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('fieldHistoryTrackingHooks', () => {
  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = fieldHistoryTrackingHooks();

    expect(hooks.name).toBe('field-history-tracking');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('post');
    expect(hooks.hooks[0].handler).toBeTypeOf('function');
  });

  // --------------------------------------------------------------------------
  // Guard: no org
  // --------------------------------------------------------------------------

  it('should skip when no org is available', async () => {
    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger}));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no org connection'),
    );
  });

  it('should skip when org is not an Org instance', async () => {
    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger, org: {notAnOrg: true}}));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not an Org instance'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: scratch org
  // --------------------------------------------------------------------------

  it('should skip scratch orgs by default', async () => {
    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();
    const org = createMockOrg({isScratch: true});

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {fhtFields: ['Account.MyField__c'], type: 'Source'},
    }));

    expect(org.determineIfScratch).toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('scratch org'),
    );
  });

  it('should not skip scratch orgs when skipScratchOrgs is false', async () => {
    const hooks = fieldHistoryTrackingHooks({skipScratchOrgs: false});
    const logger = createLogger();
    const org = createMockOrg({isScratch: true});

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {fhtFields: [], type: 'Source'},
    }));

    expect(org.determineIfScratch).not.toHaveBeenCalled();
  });

  // --------------------------------------------------------------------------
  // Guard: no FHT fields
  // --------------------------------------------------------------------------

  it('should skip when package has no fhtFields', async () => {
    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();
    const org = createMockOrg();

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {fhtFields: [], type: 'Source'},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no tracked fields'),
    );
  });

  it('should skip when sfpmPackage is undefined', async () => {
    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();
    const org = createMockOrg();

    await hooks.hooks[0].handler(createContext({logger, org}));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no tracked fields'),
    );
  });

  // --------------------------------------------------------------------------
  // Enabler Invocation
  // --------------------------------------------------------------------------

  it('should create enabler with history type and invoke enableTracking', async () => {
    vi.mocked(FieldTrackingEnabler).mockImplementation(function() { return {
      enableTracking: vi.fn().mockResolvedValue({fieldsEnabled: 2, fieldsSkipped: 0, success: true}),
    }; } as any);

    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();
    const org = createMockOrg();
    const fhtFields = ['Account.FieldA__c', 'Contact.FieldB__c'];

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {fhtFields, type: 'Source'},
    }));

    expect(FieldTrackingEnabler).toHaveBeenCalledWith(
      org.getConnection(),
      'history',
      logger,
    );

    const enablerInstance = vi.mocked(FieldTrackingEnabler).mock.results[0].value;
    expect(enablerInstance.enableTracking).toHaveBeenCalledWith(fhtFields);

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('enabled tracking on 2 field(s)'),
    );
  });

  it('should log debug when all fields already enabled', async () => {
    vi.mocked(FieldTrackingEnabler).mockImplementation(function() { return {
      enableTracking: vi.fn().mockResolvedValue({fieldsEnabled: 0, fieldsSkipped: 1, success: true}),
    }; } as any);

    const hooks = fieldHistoryTrackingHooks();
    const logger = createLogger();
    const org = createMockOrg();

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {fhtFields: ['Account.A__c'], type: 'Source'},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('already have tracking enabled'),
    );
  });
});
