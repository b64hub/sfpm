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
import { NimbusGraphProvider } from '../../../src/adapters/nimbus/nimbus-graph-provider.js';
import type { NimbusAdapterDeps } from '../../../src/adapters/nimbus/config.js';

function loadFixture(name: string) {
  return JSON.parse(
    readFileSync(new URL(`../../../test/fixtures/${name}`, import.meta.url), 'utf8'),
  );
}

function makeDeps(): NimbusAdapterDeps {
  return {
    logger: {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(),
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

const CTX = { projectRoot: '/project', packageId: 'pkg' } as const;

function mockNimbus(fixture: unknown) {
  vi.mocked(runNimbus).mockResolvedValue({
    exitCode: 0, stdout: JSON.stringify(fixture), stderr: '', timedOut: false,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveNimbusBinary).mockResolvedValue('/usr/bin/nimbus');
});

describe('NimbusGraphProvider', () => {
  it('throws when nimbus binary is not found', async () => {
    vi.mocked(resolveNimbusBinary).mockResolvedValue(undefined);
    await expect(
      new NimbusGraphProvider(makeDeps()).getMetadataDependencies({ name: 'OrderService', type: 'ApexClass' }, CTX),
    ).rejects.toThrow('Install nimbus');
  });

  it('throws when nimbus graph exits non-zero', async () => {
    vi.mocked(runNimbus).mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'class not found', timedOut: false });
    await expect(
      new NimbusGraphProvider(makeDeps()).getMetadataDependencies({ name: 'Unknown', type: 'ApexClass' }, CTX),
    ).rejects.toThrow('nimbus graph Unknown failed');
  });

  describe('ApexClass — orderservice fixture', () => {
    it('passes correct CLI args (no prefix)', async () => {
      mockNimbus(loadFixture('nimbus-graph-orderservice.json'));
      await new NimbusGraphProvider(makeDeps()).getMetadataDependencies({ name: 'OrderService', type: 'ApexClass' }, CTX);
      expect(runNimbus).toHaveBeenCalledWith(
        '/usr/bin/nimbus', ['graph', 'OrderService', '--json'], '/project', expect.any(Object),
      );
    });

    it('maps root node identity and details', async () => {
      const fixture = loadFixture('nimbus-graph-orderservice.json');
      mockNimbus(fixture);
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'OrderService', type: 'ApexClass' }, CTX,
      );

      // name and file come from the graph node, not the ref
      expect(node.metadataName).toBe('OrderService');
      expect(node.metadataType).toBe('ApexClass');
      expect(node.fileName).toBe('src/sales/order-management/dist/force-app/classes/services/OrderService.cls');
      expect(node.details).toEqual({ metadataType: 'ApexClass', isTest: false });
      expect(node.coverage).toEqual({ hasRun: false, recordedAt: null, stale: null });
    });

    it('emits outbound calls edges for class dependencies', async () => {
      mockNimbus(loadFixture('nimbus-graph-orderservice.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'OrderService', type: 'ApexClass' }, CTX,
      );

      const outbound = node.edges.filter(e => e.direction === 'outbound');
      expect(outbound.length).toBeGreaterThan(0);

      // class → class edges have no op → 'calls'
      const callEdges = outbound.filter(e => e.relation === 'calls');
      expect(callEdges.length).toBeGreaterThan(0);
      expect(callEdges.some(e => e.target.name === 'StringFormatUtility')).toBe(true);
      callEdges.forEach(e => {
        expect(e.target.type).toBe('ApexClass');
        expect(e.confidence).toBe('static');
        expect(e.transitive).toBe(false);
      });
    });

    it('emits outbound reads edge for SObject query (op:query)', async () => {
      mockNimbus(loadFixture('nimbus-graph-orderservice.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'OrderService', type: 'ApexClass' }, CTX,
      );

      const readEdges = node.edges.filter(e => e.direction === 'outbound' && e.relation === 'reads');
      expect(readEdges.length).toBeGreaterThan(0);
      readEdges.forEach(e => expect(e.target.type).toBe('SObject'));
    });

    it('emits inbound edges and sets testContext from node.is_test', async () => {
      mockNimbus(loadFixture('nimbus-graph-orderservice.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'OrderService', type: 'ApexClass' }, CTX,
      );

      const inbound = node.edges.filter(e => e.direction === 'inbound');
      expect(inbound.length).toBeGreaterThan(0);

      // All inbound are class→class so relation is 'calls'
      inbound.forEach(e => expect(e.relation).toBe('calls'));

      // Test classes set testContext true, non-test classes set it false
      expect(inbound.some(e => e.testContext && e.target.name === 'OrderServiceTest')).toBe(true);
      expect(inbound.some(e => !e.testContext && e.target.name === 'CvcOrderEventHandler')).toBe(true);
    });

    it('only includes edges directly involving the root (no context-only edges)', async () => {
      const fixture = loadFixture('nimbus-graph-orderservice.json');
      mockNimbus(fixture);
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'OrderService', type: 'ApexClass' }, CTX,
      );

      // Total edges in fixture is 138 — our node should only have the subset touching root
      const rootEdgeCount = fixture.edges.filter(
        (e: { from: string; to: string }) => e.from === 'orderservice' || e.to === 'orderservice',
      ).length;
      expect(node.edges.length).toBe(rootEdgeCount);
    });
  });

  describe('SObject — Account fixture', () => {
    it('passes correct CLI args (SObject prefix)', async () => {
      mockNimbus(loadFixture('nimbus-graph-sobject.json'));
      await new NimbusGraphProvider(makeDeps()).getMetadataDependencies({ name: 'Account', type: 'SObject' }, CTX);
      expect(runNimbus).toHaveBeenCalledWith(
        '/usr/bin/nimbus', ['graph', 'SObject.Account', '--json'], '/project', expect.any(Object),
      );
    });

    it('maps root node identity and details', async () => {
      mockNimbus(loadFixture('nimbus-graph-sobject.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Account', type: 'SObject' }, CTX,
      );

      expect(node.metadataName).toBe('Account');
      expect(node.metadataType).toBe('SObject');
      expect(node.fileName).toBeUndefined();          // sobject nodes have no file field
      expect(node.details).toEqual({ metadataType: 'SObject', custom: false });
      expect(node.coverage).toEqual({ hasRun: false, recordedAt: null, stale: null });
    });

    it('maps op:query edges to reads and op:dml edges to writes', async () => {
      mockNimbus(loadFixture('nimbus-graph-sobject.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Account', type: 'SObject' }, CTX,
      );

      expect(node.edges.filter(e => e.relation === 'reads').length).toBeGreaterThan(0);
      expect(node.edges.filter(e => e.relation === 'writes').length).toBeGreaterThan(0);
      // All edges are inbound (no outbound for Account in this fixture)
      node.edges.forEach(e => expect(e.direction).toBe('inbound'));
    });

    it('correctly sets testContext from source node.is_test', async () => {
      mockNimbus(loadFixture('nimbus-graph-sobject.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Account', type: 'SObject' }, CTX,
      );

      // Non-test class touching Account
      expect(node.edges.some(e => !e.testContext && e.target.name === 'EmailRecipientTargetResolver')).toBe(true);
      // Test class touching Account
      expect(node.edges.some(e => e.testContext && e.target.name === 'AccountSelectorTest')).toBe(true);
      // Flow touching Account
      const flowEdge = node.edges.find(e => e.target.type === 'Flow');
      expect(flowEdge).toBeDefined();
      expect(flowEdge!.testContext).toBe(false);
    });
  });

  describe('CustomMetadataType — Feature_Toggle__mdt fixture', () => {
    it('passes correct CLI args (no prefix)', async () => {
      mockNimbus(loadFixture('nimbus-graph-cmdt.json'));
      await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Feature_Toggle__mdt', type: 'CustomMetadataType' }, CTX,
      );
      expect(runNimbus).toHaveBeenCalledWith(
        '/usr/bin/nimbus', ['graph', 'Feature_Toggle__mdt', '--json'], '/project', expect.any(Object),
      );
    });

    it('maps root node identity and details', async () => {
      mockNimbus(loadFixture('nimbus-graph-cmdt.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Feature_Toggle__mdt', type: 'CustomMetadataType' }, CTX,
      );

      expect(node.metadataName).toBe('Feature_Toggle__mdt');
      expect(node.metadataType).toBe('CustomMetadataType');
      expect(node.fileName).toBeUndefined();          // custommetadata nodes have no file field
      expect(node.details).toEqual({ metadataType: 'CustomMetadataType', recordCount: 4 });
      expect(node.coverage).toEqual({ hasRun: false, recordedAt: null, stale: null });
    });

    it('maps class→cmdt edges to reads and distinguishes test vs non-test sources', async () => {
      const fixture = loadFixture('nimbus-graph-cmdt.json');
      mockNimbus(fixture);
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Feature_Toggle__mdt', type: 'CustomMetadataType' }, CTX,
      );

      // All inbound, all 'reads' (class reads CMT, no op)
      expect(node.edges.every(e => e.direction === 'inbound' && e.relation === 'reads')).toBe(true);

      const rootEdgeCount = fixture.edges.filter((e: { to: string }) => e.to === 'mdt:feature_toggle__mdt').length;
      expect(node.edges.length).toBe(rootEdgeCount);

      // is_test from fixture: FeatureToggleControllerTest, FeatureToggleServiceTest, FeatureToggleTest
      expect(node.edges.filter(e => e.testContext).length).toBe(3);
      expect(node.edges.some(e => !e.testContext && e.target.name === 'FeatureToggle')).toBe(true);
    });
  });

  describe('Flow — Create_Quote fixture', () => {
    it('passes correct CLI args (Flow prefix)', async () => {
      mockNimbus(loadFixture('nimbus-graph-flow.json'));
      await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Create_Quote', type: 'Flow' }, CTX,
      );
      expect(runNimbus).toHaveBeenCalledWith(
        '/usr/bin/nimbus', ['graph', 'Flow.Create_Quote', '--json'], '/project', expect.any(Object),
      );
    });

    it('maps root node identity and details', async () => {
      mockNimbus(loadFixture('nimbus-graph-flow.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Create_Quote', type: 'Flow' }, CTX,
      );

      expect(node.metadataName).toBe('Create_Quote');
      expect(node.metadataType).toBe('Flow');
      expect(node.fileName).toBe('src/sales/cpq/flows/Create_Quote.flow-meta.xml');
      // detail is flow status ("Active"), not kind/triggerObject — those remain unknown
      expect(node.details).toEqual({ metadataType: 'Flow', kind: 'unknown', triggerObject: null });
      expect(node.coverage).toEqual({ hasRun: false, recordedAt: null, stale: null });
    });

    it('maps flow→flow edges to references and flow→sobject edges by op', async () => {
      mockNimbus(loadFixture('nimbus-graph-flow.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Create_Quote', type: 'Flow' }, CTX,
      );

      expect(node.edges).toHaveLength(5); // 4 outbound + 1 inbound

      // flow → subflow (no op) → 'references'
      const subflowEdge = node.edges.find(e => e.direction === 'outbound' && e.target.type === 'Flow');
      expect(subflowEdge).toMatchObject({ relation: 'references', confidence: 'static', transitive: false });
      expect(subflowEdge!.target.name).toBe('Create_Quote_Line_Item');

      // flow → sobject op:query → 'reads'
      const readEdges = node.edges.filter(e => e.direction === 'outbound' && e.relation === 'reads');
      expect(readEdges).toHaveLength(2);
      expect(readEdges.map(e => e.target.name)).toEqual(expect.arrayContaining(['Opportunity', 'Pricebook2']));

      // flow → sobject op:dml → 'writes'
      const writeEdges = node.edges.filter(e => e.direction === 'outbound' && e.relation === 'writes');
      expect(writeEdges).toHaveLength(1);
      expect(writeEdges[0].target.name).toBe('Quote');

      // parent flow → this flow (no op, fromKind=flow) → inbound 'references'
      const inboundEdge = node.edges.find(e => e.direction === 'inbound');
      expect(inboundEdge).toMatchObject({ relation: 'references', target: { name: 'Create_Opportunity', type: 'Flow' } });
    });
  });

  describe('CustomLabel — Capacity_Disclaimer fixture', () => {
    it('passes correct CLI args (Label prefix)', async () => {
      mockNimbus(loadFixture('nimbus-graph-label.json'));
      await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Capacity_Disclaimer', type: 'CustomLabel' }, CTX,
      );
      expect(runNimbus).toHaveBeenCalledWith(
        '/usr/bin/nimbus', ['graph', 'Label.Capacity_Disclaimer', '--json'], '/project', expect.any(Object),
      );
    });

    it('maps root node identity and details', async () => {
      mockNimbus(loadFixture('nimbus-graph-label.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Capacity_Disclaimer', type: 'CustomLabel' }, CTX,
      );

      expect(node.metadataName).toBe('Capacity_Disclaimer');
      expect(node.metadataType).toBe('CustomLabel');
      expect(node.fileName).toBeUndefined();          // label nodes have no file field
      expect(node.details).toEqual({
        metadataType: 'CustomLabel',
        value: 'Tilbudet er underlagt den til enhver tid gjeldende produktavtale og tilhørende v…',
      });
      expect(node.coverage).toEqual({ hasRun: false, recordedAt: null, stale: null });
    });

    it('produces no edges when fixture has edges:null', async () => {
      mockNimbus(loadFixture('nimbus-graph-label.json'));
      const node = await new NimbusGraphProvider(makeDeps()).getMetadataDependencies(
        { name: 'Capacity_Disclaimer', type: 'CustomLabel' }, CTX,
      );
      expect(node.edges).toHaveLength(0);
    });
  });
});
