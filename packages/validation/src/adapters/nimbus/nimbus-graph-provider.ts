import type {
  Caveat,
  DependencyEdge,
  DependencyGraphNode,
  DependencyGraphProvider,
  EdgeRelation,
  MetadataDetails,
  MetadataRef,
  MetadataType,
} from '../../types/dependency-graph.js';
import type {ValidationContext} from '../../types/validation-context.js';
import type {NimbusAdapterDeps} from './config.js';

import {INSTALL_HINT, resolveNimbusBinary} from './nimbus-binary.js';
import {runNimbus} from './nimbus-process.js';

// ============================================================================
// Nimbus raw JSON shape (nimbus.graph/v1)
// ============================================================================

interface NimbusNode {
  dependents: number;
  /** Present on flow, custommetadata, and label nodes. */
  detail?: string;
  /** Absent for sobject, custommetadata, and label nodes. */
  file?: string;
  id: string;
  is_test: boolean;
  kind: 'class' | 'custommetadata' | 'flow' | 'label' | 'sobject' | 'trigger';
  name: string;
}

interface NimbusEdge {
  from: string;
  /** Present on SObject edges: distinguishes reads from writes. */
  op?: 'dml' | 'query';
  provenance: 'observed' | 'static';
  to: string;
}

export interface NimbusGraphNode {
  /** Null when the root has no relationships (e.g. an unreferenced label). */
  edges: NimbusEdge[] | null;
  limits: string[];
  nodes: NimbusNode[];
  schema?: string;
  scope: {
    depth: number;
    root: string;
    truncated: boolean;
  };
  stats: {
    custom_metadata_count: number;
    custom_permission_count: number;
    cycle_count: number;
    edge_count: number;
    flow_count: number;
    label_count: number;
    node_count: number;
    observed_edges: number;
    sobject_count: number;
    static_resource_count: number;
    trigger_count: number;
    unchecked_custom_permissions: number;
    unread_static_resources: number;
    unreferenced_labels: number;
  };
}

// ============================================================================
// Nimbus CLI argument prefix per metadata type
// ============================================================================

const TYPE_TO_PREFIX = new Map<MetadataType, string>([
  ['ApexClass', ''],
  ['ApexTrigger', ''],
  ['CustomLabel', 'Label'],
  ['CustomMetadataType', ''],
  ['Flow', 'Flow'],
  ['SObject', 'SObject'],
]);

// ============================================================================
// Limits → Caveat mapping
//
// ponytail: keyword heuristic — exact Nimbus prose unknown. Replace with a
// lookup table once Nimbus documents its limit strings.
// ============================================================================

const LIMITS_PATTERNS: Array<[RegExp, Caveat['code']]> = [
  [/dynamic.*soql/i,           'dynamic-soql-not-read'],
  [/flow.*edge/i,              'flow-edges-not-drawn'],
  [/formula/i,                 'formula-refs-not-read'],
  [/lwc|aura/i,                'lwc-aura-refs-not-read'],
  [/name.*match|dispatch/i,    'name-matched-dispatch'],
  [/no.*coverage|never.*run/i, 'observed-data-missing'],
  [/stale/i,                   'observed-data-stale'],
];

function parseCaveats(limits: string[]): Caveat[] {
  const seen = new Set<Caveat['code']>();
  const caveats: Caveat[] = [];
  for (const limit of limits) {
    for (const [pattern, code] of LIMITS_PATTERNS) {
      if (!seen.has(code) && pattern.test(limit)) {
        seen.add(code);
        caveats.push({code});
      }
    }
  }

  return caveats;
}

// ============================================================================
// Node → domain type helpers
// ============================================================================

function kindToMetadataType(kind: NimbusNode['kind']): MetadataType {
  switch (kind) {
  case 'class': {return 'ApexClass';
  }

  case 'custommetadata': {return 'CustomMetadataType';
  }

  case 'flow': {return 'Flow';
  }

  case 'label': {return 'CustomLabel';
  }

  case 'sobject': {return 'SObject';
  }

  case 'trigger': {return 'ApexTrigger';
  }
  }
}

function edgeRelation(
  op: NimbusEdge['op'],
  fromKind: NimbusNode['kind'],
  toKind: NimbusNode['kind'],
): EdgeRelation {
  if (op === 'query') return 'reads';
  if (op === 'dml')   return 'writes';
  if (fromKind === 'flow') return 'references';
  // class/trigger → custommetadata or label with no explicit op is a read
  if (toKind === 'custommetadata' || toKind === 'label') return 'reads';
  return 'calls';
}

function nodeDetails(node: NimbusNode): MetadataDetails {
  switch (node.kind) {
  case 'class': {
    return {isTest: node.is_test, metadataType: 'ApexClass'};
  }

  case 'custommetadata': {
    const match = node.detail?.match(/^(\d+)/);
    return {metadataType: 'CustomMetadataType', recordCount: match ? Number.parseInt(match[1], 10) : null};
  }

  case 'flow': {
    // ponytail: flow kind/triggerObject not in graph node; add when Nimbus exposes them.
    return {kind: 'unknown', metadataType: 'Flow', triggerObject: null};
  }

  case 'label': {
    return {metadataType: 'CustomLabel', value: node.detail ?? ''};
  }

  case 'sobject': {
    // ponytail: custom flag not in graph node; using __c suffix heuristic.
    return {custom: node.name.endsWith('__c'), metadataType: 'SObject'};
  }

  case 'trigger': {
    // ponytail: events/sobject not in Nimbus graph node; add when Nimbus exposes them.
    return {events: [], metadataType: 'ApexTrigger', sobject: ''};
  }
  }
}

// ============================================================================
// Provider
// ============================================================================

export class NimbusGraphProvider implements DependencyGraphProvider {
  constructor(private deps: NimbusAdapterDeps) {}

  async getMetadataDependencies(
    ref: MetadataRef,
    context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
  ): Promise<DependencyGraphNode> {
    const logger = this.deps.logger?.child?.({
      component: 'graph',
      metadataName: ref.name,
      packageId: context.packageId,
      validator: 'nimbus',
    }) ?? this.deps.logger;
    const binary = await resolveNimbusBinary(this.deps);

    if (!binary) throw new Error(`nimbus binary not found. ${INSTALL_HINT}`);

    if (!TYPE_TO_PREFIX.has(ref.type)) {
      throw new Error(`'${ref.name}' is of unsupported metadata type '${ref.type}' for graphing.`);
    }

    const prefix = TYPE_TO_PREFIX.get(ref.type)!;
    const arg = prefix ? `${prefix}.${ref.name}` : ref.name;

    const {exitCode, stderr, stdout} = await runNimbus(
      binary,
      ['graph', arg, '--format', 'json', '--depth', '1'],
      context.projectRoot,
      {logger},
    );
    if (exitCode !== 0) throw new Error(`nimbus graph ${ref.name} failed: ${stderr}`);

    return this.mapToDependencyGraph(JSON.parse(stdout) as NimbusGraphNode, ref);
  }

  private mapToDependencyGraph(graph: NimbusGraphNode, sourceRef: MetadataRef): DependencyGraphNode {
    const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
    const rootNode = graph.nodes.find(n => n.name === graph.scope.root);

    if (!rootNode) {
      throw new Error(`Root node '${graph.scope.root}' not found in Nimbus graph response`);
    }

    const hasRun = (graph.edges ?? []).some(e => e.provenance === 'observed');

    const edges: DependencyEdge[] = (graph.edges ?? []).flatMap(e => {
      const isOutbound = e.from === rootNode.id;
      const isInbound  = e.to   === rootNode.id;
      if (!isOutbound && !isInbound) return [];

      const peerNode = isOutbound ? nodeById.get(e.to) : nodeById.get(e.from);
      if (!peerNode) return [];

      const direction = isOutbound ? 'outbound' as const : 'inbound' as const;
      const fromKind  = isOutbound ? rootNode.kind : peerNode.kind;
      const toKind    = isOutbound ? peerNode.kind  : rootNode.kind;

      return [{
        confidence: e.provenance,
        direction,
        relation: edgeRelation(e.op, fromKind, toKind),
        target: {name: peerNode.name, type: kindToMetadataType(peerNode.kind)},
        testContext: peerNode.is_test,
        transitive: false,
      }];
    });

    return {
      caveats: parseCaveats(graph.limits),
      coverage: {hasRun, recordedAt: null, stale: null},
      details: nodeDetails(rootNode),
      edges,
      fileName: rootNode.file || undefined,
      metadataName: rootNode.name,
      metadataType: sourceRef.type,
    };
  }
}
