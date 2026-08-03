import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('../../../src/adapters/nimbus/nimbus-validator.js', () => ({
  createNimbusValidator: vi.fn(),
}));
vi.mock('../../../src/adapters/nimbus/nimbus-graph-provider.js', () => ({
  // Regular function so `new NimbusGraphProvider()` doesn't throw
  NimbusGraphProvider: vi.fn(function() {}),
}));
vi.mock('../../../src/boundary-check/metadata-ownership-index.js', () => ({
  buildOwnershipIndex: vi.fn().mockReturnValue(new Map()),
}));
vi.mock('../../../src/boundary-check/find-boundary-violations.js', () => ({
  findPackageBoundaryViolations: vi.fn(),
}));

import {createNimbusValidator} from '../../../src/adapters/nimbus/nimbus-validator.js';
import {NimbusGraphProvider} from '../../../src/adapters/nimbus/nimbus-graph-provider.js';
import {buildOwnershipIndex} from '../../../src/boundary-check/metadata-ownership-index.js';
import {findPackageBoundaryViolations} from '../../../src/boundary-check/find-boundary-violations.js';
import {NimbusLocalValidator} from '../../../src/adapters/nimbus/nimbus-local-validator.js';
import type {PackageManifest} from '../../../src/boundary-check/metadata-ownership-index.js';
import type {NimbusAdapterDeps} from '../../../src/adapters/nimbus/config.js';

const CTX = {packageId: 'pkg-a', packagePath: '/project/pkg-a', projectRoot: '/project'} as const;

function makeDeps(): NimbusAdapterDeps {
  return {
    config: {
      daemon: {autoStart: false, autoStop: true, enabled: false},
      supportedVersionRange: '^1.0.0',
    },
    eventBus: {emit: vi.fn().mockReturnValue(true)} as any,
    logger: {
      child: vi.fn().mockReturnThis(),
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
    } as any,
  };
}

const MANIFESTS: PackageManifest[] = [
  {declaredDependencies: new Set(['pkg-b']), packageId: 'pkg-a', packagePath: '/project/pkg-a'},
  {declaredDependencies: new Set(),          packageId: 'pkg-b', packagePath: '/project/pkg-b'},
];

function makeValidator() {
  const fakeInner = {
    capabilities: ['compile', 'test'],
    checkAvailability: vi.fn(),
    name: 'nimbus',
    run: vi.fn(),
  };
  vi.mocked(createNimbusValidator).mockReturnValue(fakeInner as any);
  vi.mocked(NimbusGraphProvider).mockImplementation(function() { return {} as any; });
  return {validator: new NimbusLocalValidator(makeDeps(), MANIFESTS), fakeInner};
}

describe('NimbusLocalValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(buildOwnershipIndex).mockReturnValue(new Map());
  });

  it('builds ownership index from manifests at construction', () => {
    makeValidator();
    expect(buildOwnershipIndex).toHaveBeenCalledWith(MANIFESTS);
  });

  describe('checkAvailability', () => {
    it('delegates to the inner validator', async () => {
      const {validator, fakeInner} = makeValidator();
      const result = {available: true, compatible: true, version: '1.0.0'};
      fakeInner.checkAvailability.mockResolvedValue(result);

      const out = await validator.checkAvailability({packageId: 'pkg-a'});

      expect(fakeInner.checkAvailability).toHaveBeenCalledWith({packageId: 'pkg-a'});
      expect(out).toBe(result);
    });
  });

  describe('compile', () => {
    it('delegates to inner validator run("compile") and strips capability field', async () => {
      const {validator, fakeInner} = makeValidator();
      fakeInner.run.mockResolvedValue({
        capability: 'compile',
        diagnostics: [],
        durationMs: 42,
        status: 'passed',
      });

      const result = await validator.compile(CTX);

      expect(fakeInner.run).toHaveBeenCalledWith('compile', CTX);
      expect(result).toEqual({diagnostics: [], durationMs: 42, raw: undefined, status: 'passed'});
      expect(result).not.toHaveProperty('capability');
    });

    it('passes through failed status and diagnostics', async () => {
      const {validator, fakeInner} = makeValidator();
      fakeInner.run.mockResolvedValue({
        capability: 'compile',
        diagnostics: [{message: 'Type error', severity: 'error'}],
        durationMs: 10,
        status: 'failed',
      });

      const result = await validator.compile(CTX);
      expect(result.status).toBe('failed');
      expect(result.diagnostics).toHaveLength(1);
    });
  });

  describe('test', () => {
    it('delegates to inner validator run("test") and strips capability field', async () => {
      const {validator, fakeInner} = makeValidator();
      fakeInner.run.mockResolvedValue({
        capability: 'test',
        diagnostics: [],
        durationMs: 100,
        status: 'passed',
      });

      const result = await validator.test(CTX);

      expect(fakeInner.run).toHaveBeenCalledWith('test', CTX);
      expect(result).not.toHaveProperty('capability');
      expect(result.status).toBe('passed');
    });
  });

  describe('checkDependencies', () => {
    it('returns skipped when packageId is not in manifests', async () => {
      const {validator} = makeValidator();
      const result = await validator.checkDependencies({
        packageId: 'unknown-pkg', packagePath: '/x', projectRoot: '/x',
      });
      expect(result.status).toBe('skipped');
      expect(findPackageBoundaryViolations).not.toHaveBeenCalled();
    });

    it('returns passed with empty violations on clean analysis', async () => {
      const {validator} = makeValidator();
      vi.mocked(findPackageBoundaryViolations).mockResolvedValue({
        caveats: [], unresolved: [], violations: [],
      });

      const result = await validator.checkDependencies(CTX);

      expect(result.status).toBe('passed');
      expect(result.violations).toHaveLength(0);
      expect(result.caveats).toHaveLength(0);
    });

    it('returns failed when violations are found', async () => {
      const {validator} = makeValidator();
      vi.mocked(findPackageBoundaryViolations).mockResolvedValue({
        caveats: ['dynamic-soql-not-read'],
        unresolved: [],
        violations: [{fromMetadata: 'OrderService', fromPackage: 'pkg-a', toMetadata: 'Logger', toPackage: 'pkg-c'}],
      });

      const result = await validator.checkDependencies(CTX);

      expect(result.status).toBe('failed');
      expect(result.violations).toHaveLength(1);
      expect(result.caveats).toContain('dynamic-soql-not-read');
    });

    it('returns error status when findPackageBoundaryViolations throws', async () => {
      const {validator} = makeValidator();
      vi.mocked(findPackageBoundaryViolations).mockRejectedValue(new Error('nimbus unreachable'));

      const result = await validator.checkDependencies(CTX);

      expect(result.status).toBe('error');
      expect(result.violations).toHaveLength(0);
    });

    it('passes the manifest and ownership index to findPackageBoundaryViolations', async () => {
      const {validator} = makeValidator();
      vi.mocked(findPackageBoundaryViolations).mockResolvedValue({
        caveats: [], unresolved: [], violations: [],
      });

      await validator.checkDependencies(CTX);

      expect(findPackageBoundaryViolations).toHaveBeenCalledWith(
        MANIFESTS[0],           // pkg manifest for 'pkg-a'
        expect.any(Map),        // ownershipIndex
        expect.any(Object),     // graphProvider
        CTX,
      );
    });
  });
});
