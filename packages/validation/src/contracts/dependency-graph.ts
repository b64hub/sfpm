import type {ValidationContext} from './validation-context.js';

// ============================================================================
// Apex class / trigger graph
// ============================================================================

export interface NimbusClassGraph {
  class: string;
  dependencies: string[];
  direct_dependents: string[];
  limits: string[];
  test_dependents: string[];
  transitive_dependents: string[];
}

// ============================================================================
// SObject graph
//
// readers / writers — Apex classes that statically name this object.
// observed_readers / observed_writers — coverage-run data; null until a run
//   has been recorded, and may be stale after code changes.
// triggers_fired — every trigger declared on this object; certain (any write
//   reaches them), not inferred.
// flows_fired — record-triggered flows are not currently drawn here.
// ============================================================================

export interface NimbusSObjectGraph {
  detail: string;
  flows_fired: null | string[];
  limits: string[];
  observed_readers: null | string[];
  observed_writers: null | string[];
  readers: null | string[];
  sobject: string;
  test_dependents: null | string[];
  transitive_dependents: null | string[];
  triggers_fired: null | string[];
  writers: null | string[];
}

// ============================================================================
// Flow graph
//
// calls — Apex classes invoked by this flow via Apex actions; null when none.
// trigger_object — SObject name for record-triggered flows; empty string
//   for screen / auto-launched flows that have no trigger object.
// triggered_by — parent flow or process that launches this one; null when
//   this flow is launched directly (button, quick action, page etc).
// ============================================================================

export interface NimbusFlowGraph {
  called_by_flows: null | string[];
  calls: null | string[];
  calls_flows: null | string[];
  detail: string;
  file: string;
  flow: string;
  limits: string[];
  objects_read: null | string[];
  objects_written: null | string[];
  test_dependents: null | string[];
  transitive_dependents: null | string[];
  trigger_object: string;
  triggered_by: null | string;
}

// ============================================================================
// Union — discriminated on the shape-specific identifier field
// ============================================================================

export type NimbusGraph = NimbusClassGraph | NimbusFlowGraph | NimbusSObjectGraph;

// ============================================================================
// Provider interface
// ============================================================================

export interface DependencyGraphProvider {
  getMetadataDependencies(
    metadataName: string,
    metadataType: string,
    context: Pick<ValidationContext, 'packageId' | 'projectRoot'>,
  ): Promise<NimbusGraph>;
}
