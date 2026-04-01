import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {PackageType} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {picklistHooks} from '../../src/picklist/picklist-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../src/picklist/picklist-enabler.js', () => ({
  PicklistEnabler: vi.fn().mockImplementation(function() { return {
    enablePicklists: vi.fn().mockResolvedValue(0),
  }; }),
}));

import {PicklistEnabler} from '../../src/picklist/picklist-enabler.js';

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

function createMockOrg() {
  const connection = {query: vi.fn(), tooling: {sobject: vi.fn()}};
  const org = Object.create(Org.prototype);
  org.getConnection = vi.fn().mockReturnValue(connection);
  return org as Org;
}

function createPicklistField(overrides?: {
  fieldManageability?: unknown;
  fullName?: string;
  objectName?: string;
  type?: string;
  valueSetDefinition?: unknown;
}) {
  return {
    name: overrides?.fullName ?? 'Status__c',
    parent: {fullName: overrides?.objectName ?? 'Account'},
    parseXmlSync: vi.fn().mockReturnValue({
      CustomField: {
        fieldManageability: overrides?.fieldManageability,
        type: overrides?.type ?? 'Picklist',
        valueSet: {
          valueSetDefinition: overrides?.valueSetDefinition ?? {
            value: [{default: false, fullName: 'Open', isActive: true, label: 'Open'}],
          },
        },
      },
    }),
  };
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    packageName: 'test-package',
    packageType: 'Unlocked',
    timing: 'post',
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('picklistHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = picklistHooks();

    expect(hooks.name).toBe('picklist');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('post');
  });

  // --------------------------------------------------------------------------
  // Guard: package type
  // --------------------------------------------------------------------------

  it('should skip non-unlocked packages', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [], type: PackageType.Source},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not an unlocked package'),
    );
  });

  it('should skip when no package model is available', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger, org: createMockOrg()}));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('not an unlocked package'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: no org
  // --------------------------------------------------------------------------

  it('should skip when no org connection is available', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {customFields: [], type: PackageType.Unlocked},
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no org connection'),
    );
  });

  // --------------------------------------------------------------------------
  // Guard: no picklist fields
  // --------------------------------------------------------------------------

  it('should skip when no picklist fields found', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no picklist fields'),
    );
  });

  // --------------------------------------------------------------------------
  // Field extraction
  // --------------------------------------------------------------------------

  it('should extract picklist fields from package model', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(1),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();
    const org = createMockOrg();
    const field = createPicklistField();

    await hooks.hooks[0].handler(createContext({
      logger,
      org,
      sfpmPackage: {customFields: [field], type: PackageType.Unlocked},
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('processing 1 picklist field(s)'),
    );

    const enablerInstance = vi.mocked(PicklistEnabler).mock.results[0].value;
    expect(enablerInstance.enablePicklists).toHaveBeenCalledWith([
      expect.objectContaining({
        fieldName: 'Status__c',
        objectName: 'Account',
        sourceValues: expect.arrayContaining([
          expect.objectContaining({fullName: 'Open'}),
        ]),
      }),
    ]);
  });

  it('should skip non-picklist field types', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();
    const textField = createPicklistField({type: 'Text'});

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [textField], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no picklist fields'),
    );
  });

  it('should skip fields with fieldManageability (CMT picklists)', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();
    const cmtField = createPicklistField({fieldManageability: 'DeveloperControlled'});

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [cmtField], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no picklist fields'),
    );
  });

  it('should skip fields without valueSetDefinition (global value sets)', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();
    const gvsField = {
      name: 'Industry__c',
      parent: {fullName: 'Account'},
      parseXmlSync: vi.fn().mockReturnValue({
        CustomField: {
          type: 'Picklist',
          valueSet: {valueSetName: 'GlobalIndustry'},
        },
      }),
    };

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [gvsField], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no picklist fields'),
    );
  });

  it('should skip fields without parent object', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();
    const noParentField = {
      name: 'Status__c',
      parseXmlSync: vi.fn().mockReturnValue({
        CustomField: {
          type: 'Picklist',
          valueSet: {valueSetDefinition: {value: [{fullName: 'A', label: 'A'}]}},
        },
      }),
    };

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [noParentField], type: PackageType.Unlocked},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no picklist fields'),
    );
  });

  it('should filter by fieldNames option when provided', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(1),
    }; } as any);

    const hooks = picklistHooks({fieldNames: ['Account.Status__c']});
    const logger = createLogger();
    const matchingField = createPicklistField({fullName: 'Status__c', objectName: 'Account'});
    const excludedField = createPicklistField({fullName: 'Priority__c', objectName: 'Case'});

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [matchingField, excludedField], type: PackageType.Unlocked},
    }));

    const enablerInstance = vi.mocked(PicklistEnabler).mock.results[0].value;
    expect(enablerInstance.enablePicklists).toHaveBeenCalledWith([
      expect.objectContaining({fieldName: 'Status__c', objectName: 'Account'}),
    ]);
  });

  it('should handle MultiselectPicklist type', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(1),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();
    const multiField = createPicklistField({type: 'MultiselectPicklist'});

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [multiField], type: PackageType.Unlocked},
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('processing 1 picklist field(s)'),
    );
  });

  it('should handle XML parse errors gracefully', async () => {
    const hooks = picklistHooks();
    const logger = createLogger();
    const brokenField = {
      name: 'Broken__c',
      parent: {fullName: 'Account'},
      parseXmlSync: vi.fn().mockImplementation(() => { throw new Error('parse error'); }),
    };

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [brokenField], type: PackageType.Unlocked},
    }));

    expect(logger.trace).toHaveBeenCalledWith(
      expect.stringContaining('failed to parse XML'),
    );
  });

  // --------------------------------------------------------------------------
  // Value normalisation
  // --------------------------------------------------------------------------

  it('should handle single value (non-array) from XML', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(1),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();
    const field = {
      name: 'Status__c',
      parent: {fullName: 'Account'},
      parseXmlSync: vi.fn().mockReturnValue({
        CustomField: {
          type: 'Picklist',
          valueSet: {
            valueSetDefinition: {
              value: {default: false, fullName: 'Single', label: 'Single'},
            },
          },
        },
      }),
    };

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [field], type: PackageType.Unlocked},
    }));

    const enablerInstance = vi.mocked(PicklistEnabler).mock.results[0].value;
    expect(enablerInstance.enablePicklists).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceValues: [expect.objectContaining({fullName: 'Single'})],
      }),
    ]);
  });

  it('should skip inactive source values', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(1),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();
    const field = {
      name: 'Status__c',
      parent: {fullName: 'Account'},
      parseXmlSync: vi.fn().mockReturnValue({
        CustomField: {
          type: 'Picklist',
          valueSet: {
            valueSetDefinition: {
              value: [
                {fullName: 'Active', isActive: true, label: 'Active'},
                {fullName: 'Inactive', isActive: 'false', label: 'Inactive'},
              ],
            },
          },
        },
      }),
    };

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {customFields: [field], type: PackageType.Unlocked},
    }));

    const enablerInstance = vi.mocked(PicklistEnabler).mock.results[0].value;
    expect(enablerInstance.enablePicklists).toHaveBeenCalledWith([
      expect.objectContaining({
        sourceValues: [expect.objectContaining({fullName: 'Active'})],
      }),
    ]);
  });

  // --------------------------------------------------------------------------
  // Result logging
  // --------------------------------------------------------------------------

  it('should log info when picklists are updated', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(3),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {
        customFields: [createPicklistField()],
        type: PackageType.Unlocked,
      },
    }));

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('updated 3 picklist(s)'),
    );
  });

  it('should log debug when all picklists in sync', async () => {
    vi.mocked(PicklistEnabler).mockImplementation(function() { return {
      enablePicklists: vi.fn().mockResolvedValue(0),
    }; } as any);

    const hooks = picklistHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {
        customFields: [createPicklistField()],
        type: PackageType.Unlocked,
      },
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('already in sync'),
    );
  });
});
