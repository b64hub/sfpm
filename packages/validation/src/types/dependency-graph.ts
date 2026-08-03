import type {ValidationContext} from './validation-context.js';

// ============================================================================
// Identity
// ============================================================================

export type MetadataType
  = | 'ApexClass'
    | 'ApexTrigger'
    | 'CustomLabel'
    | 'CustomMetadataType'
    | 'Flow'
    | 'SObject';

export interface MetadataRef {
  readonly name: string;
  readonly type: MetadataType;
}

// ============================================================================
// Edges
//
// The Nimbus graph payload is a uniform nodes + edges structure. Every entry
// in edges[] — regardless of whether its endpoints are classes, triggers,
// SObjects, flows, custom metadata types, or labels — is the same thing seen
// from different angles: a relationship to another metadata item, with a
// direction, a kind, and a degree of trust. Model that once.
// ============================================================================

export type EdgeDirection = 'inbound' | 'outbound';

export type EdgeRelation
  /** Compile-time / structural reference with no finer verb available. */
  = | 'calls'
  /** SOQL select, label read, custom metadata query. */
    | 'dispatches'
  /** DML. */
    | 'reads'
  /** Apex invocation, flow -> apex action, flow -> subflow. */
    | 'references'
  /** Indirection: Type.forName, record-field-driven handler resolution. */
    | 'triggers'
  /** A write on the source reaches the target trigger or record-triggered flow. */
    | 'writes';

/**
 * How much the edge can be trusted. This is what every `limits` string in the
 * Nimbus payload was trying to express in prose, promoted to a value.
 *
 * certain    Structurally guaranteed. A trigger declared on an object fires on
 *            any write to it; nothing was inferred.
 * static     Read out of source. Complete for the constructs the parser
 *            understands, blind to anything assembled at runtime
 *            (Database.query on a built string, System.Label.get with a
 *            computed name).
 * observed   Seen during a coverage run. Under-reports paths that run did not
 *            execute, and may be stale relative to current source. See
 *            `CoverageProvenance` on the node.
 * heuristic  Name matching or similar. Can over-claim (a field value that
 *            coincidentally matches a class name) and under-claim (indirection
 *            the reading cannot follow).
 */
export type EdgeConfidence = 'certain' | 'heuristic' | 'observed' | 'static';

export interface DependencyEdge {
  readonly confidence: EdgeConfidence;
  /** Hops from this node. 1 = direct. Undefined when the tool reports only reachability. */
  readonly depth?: number;
  readonly direction: EdgeDirection;
  readonly relation: EdgeRelation;
  readonly target: MetadataRef;
  /** Target is test-only code. Replaces the separate `test_dependents` list. */
  readonly testContext: boolean;
  /** False = direct edge. True = reached through one or more intermediaries. */
  readonly transitive: boolean;
}

// ============================================================================
// Provenance
//
// Derived from the graph's edge provenance. One place says "no coverage run
// has been recorded" rather than leaving the consumer to infer it from
// absent observed edges.
// ============================================================================

export interface CoverageProvenance {
  readonly hasRun: boolean;
  /** ISO-8601. Null when hasRun is false. */
  readonly recordedAt: null | string;
  /** Source changed since the run. Null when unknown. */
  readonly stale: boolean | null;
}

// ============================================================================
// Caveats
// ============================================================================

export type CaveatCode
  = | 'dynamic-soql-not-read'
    | 'flow-edges-not-drawn'
    | 'formula-refs-not-read'
    | 'lwc-aura-refs-not-read'
    | 'name-matched-dispatch'
    | 'observed-data-missing'
    | 'observed-data-stale';

export interface Caveat {
  readonly code: CaveatCode;
  /** Which relation the caveat applies to, when scoped. */
  readonly relation?: EdgeRelation;
}

// ============================================================================
// Type-specific detail
// ============================================================================

export interface ApexClassDetails {
  readonly isTest: boolean;
  readonly metadataType: 'ApexClass';
}

export type TriggerEvent
  = | 'after delete'
    | 'after insert'
    | 'after undelete'
    | 'after update'
    | 'before delete'
    | 'before insert'
    | 'before update';

export interface ApexTriggerDetails {
  readonly events: readonly TriggerEvent[];
  readonly metadataType: 'ApexTrigger';
  readonly sobject: string;
}

export interface SObjectDetails {
  readonly custom: boolean;
  readonly metadataType: 'SObject';
}

export interface CustomMetadataTypeDetails {
  readonly metadataType: 'CustomMetadataType';
  readonly recordCount: null | number;
}

export type FlowKind = 'autolaunched' | 'record-triggered' | 'screen' | 'unknown';

export interface FlowDetails {
  readonly kind: FlowKind;
  readonly metadataType: 'Flow';
  /** Null for screen / auto-launched flows. Was the empty-string sentinel. */
  readonly triggerObject: null | string;
}

export interface CustomLabelDetails {
  readonly metadataType: 'CustomLabel';
  /** Full value, not truncated for display. */
  readonly value: string;
}

export type MetadataDetails
  = | ApexClassDetails
    | ApexTriggerDetails
    | CustomLabelDetails
    | CustomMetadataTypeDetails
    | FlowDetails
    | SObjectDetails;

// ============================================================================
// Node
// ============================================================================

export interface DependencyGraphNode {
  readonly caveats: readonly Caveat[];
  readonly coverage: CoverageProvenance;
  /** Discriminated on metadataType; always matches the node's metadataType. */
  readonly details: MetadataDetails;
  readonly edges: readonly DependencyEdge[];
  readonly fileName?: string;
  readonly metadataName: string;
  readonly metadataType: MetadataType;
}

// ============================================================================
// Accessors
//
// Keep the ergonomics of named buckets without paying for them in the type.
// ============================================================================

const matches
  = (direction: EdgeDirection, relations: readonly EdgeRelation[], transitive?: boolean) =>
    (edge: DependencyEdge): boolean =>
      edge.direction === direction
      && relations.includes(edge.relation)
      && (transitive === undefined || edge.transitive === transitive);

export const directDependencies = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(matches('outbound', ['calls', 'reads', 'references', 'writes'], false));

export const directDependents = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(matches('inbound', ['calls', 'reads', 'references', 'writes'], false));

export const transitiveDependents = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(edge => edge.direction === 'inbound' && edge.transitive);

export const testDependents = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(edge => edge.direction === 'inbound' && edge.testContext);

export const readers = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(matches('inbound', ['reads']));

export const writers = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(matches('inbound', ['writes']));

export const triggersFired = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(matches('outbound', ['triggers']));

/** Edges the caller should treat as suggestive rather than authoritative. */
export const uncertainEdges = (node: DependencyGraphNode): readonly DependencyEdge[] =>
  node.edges.filter(edge => edge.confidence === 'heuristic' || edge.confidence === 'observed');

// ============================================================================
// Provider
// ============================================================================

export interface DependencyGraphProvider {
  getMetadataDependencies(
    ref: MetadataRef,
    context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
  ): Promise<DependencyGraphNode>;
}

