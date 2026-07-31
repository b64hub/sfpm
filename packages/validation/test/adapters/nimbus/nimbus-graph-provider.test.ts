import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/adapters/nimbus/nimbus-binary.js', () => ({
  INSTALL_HINT: 'Install nimbus: curl -fsSL https://install.testnimbus.dev | sh',
  resolveNimbusBinary: vi.fn(),
}));
vi.mock('../../../src/adapters/nimbus/nimbus-process.js', () => ({
  runNimbus: vi.fn(),
}));

import { resolveNimbusBinary } from '../../../src/adapters/nimbus/nimbus-binary.js';
import { runNimbus } from '../../../src/adapters/nimbus/nimbus-process.js';
import { createNimbusGraphProvider } from '../../../src/adapters/nimbus/nimbus-graph-provider.js';
import { buildOwnershipIndex } from '../../../src/boundary-check/metadata-ownership-index.js';
import { findPackageBoundaryViolations } from '../../../src/boundary-check/find-boundary-violations.js';
import type { NimbusAdapterDeps } from '../../../src/adapters/nimbus/config.js';
import type { PackageManifest } from '../../../src/boundary-check/metadata-ownership-index.js';

const graphFixture = JSON.parse(
  readFileSync(new URL('../../../test/fixtures/nimbus-graph-orderservice.json', import.meta.url), 'utf8'),
);

function makeDeps(): NimbusAdapterDeps {
  return {
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      trace: vi.fn(),
      child: vi.fn().mockReturnThis() as unknown as NimbusAdapterDeps['logger']['child'],
    },
    eventBus: { emit: vi.fn().mockReturnValue(true) },
    config: {
      pinnedVersion: '1.2.3',
      supportedVersionRange: '^1.2.0',
      autoInstall: false,
      dataDir: '/test-data',
      daemon: { enabled: false, autoStart: false, autoStop: true },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
});

describe('createNimbusGraphProvider', () => {
  it('calls runNimbus with correct args and parses JSON response', async () => {
    vi.mocked(runNimbus).mockResolvedValue({
      exitCode: 0,
      stdout: JSON.stringify(graphFixture),
      stderr: '',
      timedOut: false,
    });

    const provider = createNimbusGraphProvider(makeDeps());
    const result = await provider.getMetadataDependencies('orderservice', 'apexclass', {
      projectRoot: '/project',
      packageId: 'order-service-pkg',
    });

    expect(runNimbus).toHaveBeenCalledWith(
      '/usr/bin/nimbus',
      ['graph', 'orderservice', '--json'],
      '/project',
      expect.any(Object),
    );
    expect(result.class).toBe('orderservice');
    expect(result.dependencies).toContain('stringformatutility');
  });

  it('throws when nimbus graph exits non-zero', async () => {
    vi.mocked(runNimbus).mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'class not found',
      timedOut: false,
    });

    const provider = createNimbusGraphProvider(makeDeps());
    await expect(
      provider.getMetadataDependencies('unknownclass', 'apexclass', { projectRoot: '/project', packageId: 'pkg' }),
    ).rejects.toThrow('nimbus graph unknownclass failed');
  });

  it('throws with install hint when binary not found', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue(undefined);

    const provider = createNimbusGraphProvider(makeDeps());
    await expect(
      provider.getMetadataDependencies('someclass', 'apexclass', { projectRoot: '/project', packageId: 'pkg' }),
    ).rejects.toThrow('Install nimbus');
  });
});

describe('graph fixture → boundary violation integration', () => {
  it('detects stringformatutility as a violation when its package is undeclared', async () => {
    // OrderService (order-service-pkg) depends on StringFormatUtility (string-utils-pkg)
    // string-utils-pkg is NOT in declaredDependencies → violation
    const manifests: PackageManifest[] = [
      {
        packageId: 'order-service-pkg',
        ownedFiles: new Set(['/project/order-service-pkg/OrderService.cls']),
        declaredDependencies: new Set(['order-repo-pkg']), // order-repo-pkg declared, string-utils-pkg NOT
      },
      {
        packageId: 'order-repo-pkg',
        ownedFiles: new Set(['/project/order-repo-pkg/OrderRepository.cls']),
        declaredDependencies: new Set(),
      },
      {
        packageId: 'string-utils-pkg',
        ownedFiles: new Set(['/project/string-utils-pkg/StringFormatUtility.cls']),
        declaredDependencies: new Set(),
      },
    ];

    const ownershipIndex = buildOwnershipIndex(manifests);

    // Fake provider always returns the fixture (only one class in this pkg)
    const fakeProvider = {
      getMetadataDependencies: vi.fn().mockResolvedValue(graphFixture),
    };

    const result = await findPackageBoundaryViolations(
      manifests[0],
      ownershipIndex,
      fakeProvider,
      { projectRoot: '/project', packageId: 'order-service-pkg' },
    );

    // stringformatutility → violation
    const violation = result.violations.find((v) => v.toClass === 'stringformatutility');
    expect(violation).toBeDefined();
    expect(violation?.fromPackage).toBe('order-service-pkg');
    expect(violation?.toPackage).toBe('string-utils-pkg');

    // orderrepository is declared → no violation
    expect(result.violations.filter((v) => v.toClass === 'orderrepository')).toHaveLength(0);
  });
});
