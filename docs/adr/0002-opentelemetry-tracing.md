# ADR 0002: OpenTelemetry Tracing Strategy

## Status
Accepted

## Context
SFPM orchestrates multi-package Salesforce builds and installs with concurrent execution. Observability into build durations, failure rates, and pipeline structure is needed for debugging and performance analysis. The existing event system (~70+ typed events via Node.js EventEmitter) already models the complete lifecycle.

## Decision

### Signal Type
**Traces only** (spans with parent-child relationships and timing). Metrics can be derived from traces downstream via an OTel collector. Starting with traces avoids doubling the integration surface.

### Architecture
A new `@b64hub/sfpm-telemetry` package subscribes to EventEmitter events and produces OTel spans. Core packages remain completely agnostic to telemetry — no OTel imports or dependencies.

```
Core (events) ──EventEmitter──▶ Telemetry (span map) ──OTel SDK──▶ Collector
                                    ▲
                            createTracer(emitter)
                                    │
                          CLI / Actions entrypoint
```

### Activation
Auto-on when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No SFPM-specific flags or env vars needed. If the user configures an OTel collector, traces flow. If not, the SDK is never initialized (zero overhead).

### Public API
```ts
import { createTracer } from '@b64hub/sfpm-telemetry';

const tracer = createTracer({ serviceName: 'sfpm-actions' });
tracer.subscribe(orchestrator);
await orchestrator.buildAll(packages);
await tracer.shutdown();
```

### Event-to-Span Mapping
A declarative `SpanMapping` registry defines how event pairs become spans:
- Each mapping specifies `start`/`end` event names, a `spanKey` for instance identity, optional `parentKey` for hierarchy, and attribute extractors.
- A `SpanEngine` maintains an active span registry (`Map<string, Span>`), creating spans on start events and ending them on end events.

### Initial Span Granularity
Coarse — orchestration root span + per-package build/install spans. Sub-operation spans (connection, staging, assembly) can be added incrementally by appending entries to the span map.

### Correlation
- `orchestrationId` (UUID) generated in the base `Orchestrator` at the start of `executeAll()` and emitted on orchestration events only
- Build/install spans link to the orchestration parent via a fixed key (`'orchestration'`). Since only one orchestration runs per process, no ID-based lookup is needed.
- **Turborepo compatibility**: When `TURBO_RUN_ID` is detected, the tracer auto-creates a synthetic orchestration root span on `subscribe()`. Build/install spans parent to it just like they would with the native orchestrator. `TURBO_RUN_ID` and `TURBO_HASH` are captured as span attributes for cross-process correlation.
- When neither orchestrator nor turbo is active, build/install spans become root spans automatically.

### Attribute Naming
`sfpm.*` namespace following OTel semantic conventions for domain-specific attributes:
- `sfpm.orchestration.id`, `sfpm.orchestration.total_packages`
- `sfpm.package.name`, `sfpm.package.type`
- `sfpm.build.success`, `sfpm.install.success`

### Error Handling
- `setStatus(SpanStatusCode.ERROR)` with error message
- `recordException()` when an `Error` object is available
- Falls back to error message string when only a string is provided

### Service Version
Auto-detected from the nearest `package.json` by walking up from `process.cwd()`.

### Testing
`InMemorySpanExporter` from `@opentelemetry/sdk-trace-node` for unit tests — emit mock events, assert spans have correct names, attributes, parent-child relationships, and error status.

## Consequences

### Positive
- Zero coupling between core packages and telemetry
- Adding new spans is purely additive (new span map entry)
- Standard OTel configuration — works with any backend (Honeycomb, Datadog, Jaeger, etc.)
- No overhead when tracing is disabled (SDK never initialized)

### Negative
- Additional dependency tree (`@opentelemetry/*`) in the telemetry package

### Neutral
- Entrypoints must call `createTracer()` and `shutdown()` — explicit opt-in
- Span granularity is deliberately coarse initially — can be extended later
