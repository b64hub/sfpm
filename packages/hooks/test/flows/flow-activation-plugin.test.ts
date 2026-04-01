import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import type {HookContext} from '@b64/sfpm-core';
import {PackageType} from '@b64/sfpm-core';
import {Org} from '@salesforce/core';

import {flowActivationHooks} from '../../src/flows/flow-activation-plugin.js';

// ============================================================================
// Mocks
// ============================================================================

vi.mock('../../src/flows/flow-activator.js', () => ({
  FlowActivator: vi.fn().mockImplementation(function() { return {
    processFlows: vi.fn().mockResolvedValue({activated: 0, deactivated: 0}),
  }; }),
}));

import {FlowActivator} from '../../src/flows/flow-activator.js';

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
  const connection = {query: vi.fn()};
  const org = Object.create(Org.prototype);
  org.getConnection = vi.fn().mockReturnValue(connection);
  return org as Org;
}

function createContext(overrides?: Partial<HookContext>): HookContext {
  return {
    operation: 'install',
    packageName: 'test-package',
    timing: 'post',
    ...overrides,
  };
}

function createFlowComponent(fullName: string, status = 'Active') {
  return {
    fullName,
    parseXmlSync: () => ({Flow: {status}}),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('flowActivationHooks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Structure
  // --------------------------------------------------------------------------

  it('should return valid LifecycleHooks', () => {
    const hooks = flowActivationHooks();

    expect(hooks.name).toBe('flow-activation');
    expect(hooks.hooks).toHaveLength(1);
    expect(hooks.hooks[0].operation).toBe('install');
    expect(hooks.hooks[0].timing).toBe('post');
  });

  // --------------------------------------------------------------------------
  // Guards
  // --------------------------------------------------------------------------

  it('should skip when no package model', async () => {
    const hooks = flowActivationHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({logger, org: createMockOrg()}));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no package model'),
    );
    expect(FlowActivator).not.toHaveBeenCalled();
  });

  it('should skip data packages', async () => {
    const hooks = flowActivationHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {flows: [], type: PackageType.Data},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('data package'),
    );
  });

  it('should skip when no org connection', async () => {
    const hooks = flowActivationHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      sfpmPackage: {flows: [], type: PackageType.Source},
    }));

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('no org connection'),
    );
  });

  it('should skip when no flows in package', async () => {
    const hooks = flowActivationHooks();
    const logger = createLogger();

    await hooks.hooks[0].handler(createContext({
      logger,
      org: createMockOrg(),
      sfpmPackage: {flows: [], type: PackageType.Source},
    }));

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('no flows found'),
    );
  });

  // --------------------------------------------------------------------------
  // Flow extraction
  // --------------------------------------------------------------------------

  describe('flow extraction', () => {
    it('should extract flow entries from package components', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 1, deactivated: 0}),
      }; } as any);

      const hooks = flowActivationHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [
            createFlowComponent('MyFlow', 'Active'),
            createFlowComponent('DraftFlow', 'Draft'),
          ],
          type: PackageType.Source,
        },
      }));

      const instance = vi.mocked(FlowActivator).mock.results[0].value;
      expect(instance.processFlows).toHaveBeenCalledWith([
        {developerName: 'MyFlow', sourceStatus: 'Active'},
        {developerName: 'DraftFlow', sourceStatus: 'Draft'},
      ]);
    });

    it('should filter by flowNames option', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 1, deactivated: 0}),
      }; } as any);

      const hooks = flowActivationHooks({flowNames: ['MyFlow']});
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [
            createFlowComponent('MyFlow', 'Active'),
            createFlowComponent('OtherFlow', 'Active'),
          ],
          type: PackageType.Source,
        },
      }));

      const instance = vi.mocked(FlowActivator).mock.results[0].value;
      expect(instance.processFlows).toHaveBeenCalledWith([
        {developerName: 'MyFlow', sourceStatus: 'Active'},
      ]);
    });

    it('should skip flows that fail XML parsing', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 1, deactivated: 0}),
      }; } as any);

      const hooks = flowActivationHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [
            {fullName: 'BadFlow', parseXmlSync: () => { throw new Error('parse error'); }},
            createFlowComponent('GoodFlow', 'Active'),
          ],
          type: PackageType.Source,
        },
      }));

      const instance = vi.mocked(FlowActivator).mock.results[0].value;
      expect(instance.processFlows).toHaveBeenCalledWith([
        {developerName: 'GoodFlow', sourceStatus: 'Active'},
      ]);
    });

    it('should skip flows with no status in XML', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 0, deactivated: 0}),
      }; } as any);

      const hooks = flowActivationHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [
            {fullName: 'NoStatus', parseXmlSync: () => ({Flow: {}})},
          ],
          type: PackageType.Source,
        },
      }));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('no flows found'),
      );
    });
  });

  // --------------------------------------------------------------------------
  // Activator invocation
  // --------------------------------------------------------------------------

  describe('activator invocation', () => {
    it('should create FlowActivator with connection and options', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 1, deactivated: 0}),
      }; } as any);

      const activationOptions = {skipAlreadyActive: true};
      const hooks = flowActivationHooks(activationOptions);
      const logger = createLogger();
      const org = createMockOrg();

      await hooks.hooks[0].handler(createContext({
        logger,
        org,
        sfpmPackage: {
          flows: [createFlowComponent('MyFlow', 'Active')],
          type: PackageType.Source,
        },
      }));

      expect(FlowActivator).toHaveBeenCalledWith(
        org.getConnection(),
        activationOptions,
        logger,
      );
    });

    it('should log activation/deactivation counts', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 2, deactivated: 1}),
      }; } as any);

      const hooks = flowActivationHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [
            createFlowComponent('Flow1', 'Active'),
            createFlowComponent('Flow2', 'Active'),
            createFlowComponent('Flow3', 'Draft'),
          ],
          type: PackageType.Source,
        },
      }));

      expect(logger.info).toHaveBeenCalledWith(
        expect.stringContaining('activated 2, deactivated 1'),
      );
    });

    it('should log "already in sync" when no changes', async () => {
      vi.mocked(FlowActivator).mockImplementation(function() { return {
        processFlows: vi.fn().mockResolvedValue({activated: 0, deactivated: 0}),
      }; } as any);

      const hooks = flowActivationHooks();
      const logger = createLogger();

      await hooks.hooks[0].handler(createContext({
        logger,
        org: createMockOrg(),
        sfpmPackage: {
          flows: [createFlowComponent('Flow1', 'Active')],
          type: PackageType.Source,
        },
      }));

      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringContaining('already in sync'),
      );
    });
  });
});
