// ─── Apex AST infrastructure ─────────────────────────────────────────────────
// Apex AST infrastructure
export {ApexAstSerializer} from './adapters/ast-serializer/apex-ast-serializer.js';
export type {RawAstResponse, SerializerOptions} from './adapters/ast-serializer/apex-ast-serializer.js';
export {ApexParser} from './adapters/ast-serializer/apex-parser.js';
export type {ApexClassInfo} from './adapters/ast-serializer/apex-parser.js';
export {default as ApexService} from './adapters/ast-serializer/apex-service.js';

// Jorje types
export type * as jorje from './adapters/ast-serializer/types/jorje.js';
// ─── Nimbus adapter ──────────────────────────────────────────────────────────
export type {NimbusAdapterConfig, NimbusDaemonConfig} from './adapters/nimbus/config.js';
export {createNimbusGraphProvider} from './adapters/nimbus/nimbus-graph-provider.js';
export {withNimbusDaemon} from './adapters/nimbus/nimbus-session.js';

export {createNimbusValidator} from './adapters/nimbus/nimbus-validator.js';
export {findPackageBoundaryViolations} from './boundary-check/find-boundary-violations.js';
export type {BoundaryCheckResult, BoundaryViolation} from './boundary-check/find-boundary-violations.js';
// ─── Boundary check ──────────────────────────────────────────────────────────
export {buildOwnershipIndex} from './boundary-check/metadata-ownership-index.js';

export type {MetadataOwnership, PackageManifest} from './boundary-check/metadata-ownership-index.js';
export type {DependencyGraphProvider, NimbusClassGraph} from './contracts/dependency-graph.js';
export type {ValidationContext} from './contracts/validation-context.js';
// ─── Nimbus validation contracts ────────────────────────────────────────────
export {NimbusValidationEventBus, ScopedValidationSink} from './contracts/validation-event-bus.js';
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
} from './contracts/validation-event-bus.js';

export type {
  AvailabilityResult,
  Diagnostic,
  ValidationCapability,
  ValidationResult,
  Validator,
} from './contracts/validator.js';

export {ApexReferenceExtractor} from './dependency/apex-reference-extractor.js';
export type {ApexTypeReference} from './dependency/apex-reference-extractor.js';
// Dependency analysis
export {MetadataDependencyService} from './dependency/metadata-dependency-service.js';
export {SymbolRegistry} from './dependency/symbol-registry.js';
export type {AnalyzablePackage} from './dependency/symbol-registry.js';
