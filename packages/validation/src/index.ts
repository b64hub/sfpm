// ─── Nimbus adapter ──────────────────────────────────────────────────────────
export type {NimbusAdapterConfig, NimbusDaemonConfig} from './adapters/nimbus/config.js';

export {NimbusGraphProvider} from './adapters/nimbus/nimbus-graph-provider.js';
export {NimbusLocalValidator} from './adapters/nimbus/nimbus-local-validator.js';
export {withNimbusDaemon} from './adapters/nimbus/nimbus-session.js';
export {createNimbusValidator} from './adapters/nimbus/nimbus-validator.js';
export {findPackageBoundaryViolations} from './boundary-check/find-boundary-violations.js';

export type {BoundaryCheckResult, BoundaryViolation} from './boundary-check/find-boundary-violations.js';
// ─── Boundary check ──────────────────────────────────────────────────────────
export {buildOwnershipIndex} from './boundary-check/metadata-ownership-index.js';
export type {MetadataOwnership, PackageManifest} from './boundary-check/metadata-ownership-index.js';

export type {DependencyGraphProvider} from './types/dependency-graph.js';
export type {ValidationContext} from './types/validation-context.js';
// ─── Nimbus validation contracts ────────────────────────────────────────────
export {NimbusValidationEventBus, ScopedValidationSink} from './types/validation-event-bus.js';
export type {
  NimbusDaemonUnavailablePayload,
  NimbusValidationEvents,
  ValidationEventBus,
  ValidationEventSink,
  ValidatorAvailabilityPayload,
  ValidatorCompletePayload,
  ValidatorErrorPayload,
  ValidatorProgressPayload,
  ValidatorStartPayload,
} from './types/validation-event-bus.js';
export type {
  AvailabilityResult,
  Diagnostic,
  ValidationCapability,
  ValidationResult,
  Validator,
} from './types/validator.js';
