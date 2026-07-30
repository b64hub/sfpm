import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComponentSet } from '@salesforce/source-deploy-retrieve';

import { SymbolRegistry } from '../../src/dependency/symbol-registry.js';

vi.mock('@salesforce/source-deploy-retrieve', () => ({
  ComponentSet: {
    fromSource: vi.fn(),
  },
}));

type MockSourceComponent = {
  name: string;
  type: {
    id: string;
  };
};

function createComponentSet(components: MockSourceComponent[]) {
  return {
    getSourceComponents: () => components,
  };
}

describe('SymbolRegistry', () => {
  let registry: SymbolRegistry;
  const mockFromSource = vi.mocked(ComponentSet.fromSource);

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new SymbolRegistry();
  });

  it('registers symbols from a package and resolves them', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        { name: 'MyService', type: { id: 'apexclass' } },
      ]) as never,
    );

    registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');

    expect(mockFromSource).toHaveBeenCalledWith('/workspace/force-app');
    expect(registry.resolve('MyService')).toBe('pkg-one');
  });

  it('resolve is case-insensitive', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        { name: 'MyService', type: { id: 'apexclass' } },
      ]) as never,
    );

    registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');

    expect(registry.resolve('myservice')).toBe('pkg-one');
    expect(registry.resolve('MYSERVICE')).toBe('pkg-one');
  });

  it('returns undefined for unresolved symbols', () => {
    mockFromSource.mockReturnValue(createComponentSet([]) as never);

    registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');

    expect(registry.resolve('MissingService')).toBeUndefined();
  });

  it('only registers apexclass and apextrigger types', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        { name: 'MyService', type: { id: 'apexclass' } },
        { name: 'MyTrigger', type: { id: 'apextrigger' } },
        { name: 'Account', type: { id: 'customobject' } },
        { name: 'myComponent', type: { id: 'lightningcomponentbundle' } },
      ]) as never,
    );

    registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');

    expect(registry.resolve('MyService')).toBe('pkg-one');
    expect(registry.resolve('MyTrigger')).toBe('pkg-one');
    expect(registry.resolve('Account')).toBeUndefined();
    expect(registry.resolve('myComponent')).toBeUndefined();
  });

  it('handles errors in ComponentSet.fromSource() gracefully', () => {
    mockFromSource.mockImplementation(() => {
      throw new Error('boom');
    });

    expect(() => {
      registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');
    }).not.toThrow();
    expect(registry.size).toBe(0);
  });

  it('reports correct size after registration', () => {
    mockFromSource.mockReturnValue(
      createComponentSet([
        { name: 'MyService', type: { id: 'apexclass' } },
        { name: 'MyHelper', type: { id: 'apexclass' } },
        { name: 'MyTrigger', type: { id: 'apextrigger' } },
        { name: 'Account', type: { id: 'customobject' } },
      ]) as never,
    );

    registry.registerPackage({ packageName: 'pkg-one', path: 'force-app' }, '/workspace');

    expect(registry.size).toBe(3);
  });

  it('registers multiple packages, resolving symbols to correct owners', () => {
    mockFromSource
      .mockReturnValueOnce(
        createComponentSet([
          { name: 'MyService', type: { id: 'apexclass' } },
          { name: 'AccountTrigger', type: { id: 'apextrigger' } },
        ]) as never,
      )
      .mockReturnValueOnce(
        createComponentSet([
          { name: 'MyUtility', type: { id: 'apexclass' } },
        ]) as never,
      );

    registry.registerPackage({ packageName: 'pkg-one', path: 'pkg-one' }, '/workspace');
    registry.registerPackage({ packageName: 'pkg-two', path: 'pkg-two' }, '/workspace');

    expect(registry.resolve('MyService')).toBe('pkg-one');
    expect(registry.resolve('AccountTrigger')).toBe('pkg-one');
    expect(registry.resolve('MyUtility')).toBe('pkg-two');
    expect(registry.size).toBe(3);
  });
});
