# Telemetry Instructions

## Overview

SFPM uses OpenTelemetry for distributed tracing. The `@b64hub/sfpm-telemetry` package subscribes to EventEmitter events and translates them into OTel spans. Core packages have zero knowledge of telemetry.

## Architecture

- **Core packages** emit events via `EventEmitter` — no OTel imports
- **`@b64hub/sfpm-telemetry`** contains the span map, span engine, and `createTracer()` API
- **Entrypoints** (CLI, Actions) call `createTracer(emitter, { serviceName })` to enable tracing

## Enabling Tracing

Tracing activates automatically when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. No SFPM-specific flags needed. All OTel configuration uses standard `OTEL_*` env vars.

## Span Map

Spans are defined declaratively via `SpanMapping` entries:

```ts
interface SpanMapping {
  name: string;         // OTel span name
  start: string;        // Start event name
  end: string;          // End event name
  spanKey: (evt) => string;           // Unique instance key
  parentKey?: (evt) => string;        // Parent span lookup key
  startAttributes?: (evt) => Record;  // Attributes from start event
  endAttributes?: (evt) => Record;    // Attributes from end event
}
```

### Adding a New Span

1. Add a new entry to `defaultSpanMappings` in `packages/telemetry/src/span-map.ts`
2. Define the `start`/`end` event pair and attribute extractors
3. Add a test in `packages/telemetry/test/span-engine.test.ts`

## Attribute Naming

Use the `sfpm.*` namespace for all custom attributes:
- `sfpm.orchestration.id`
- `sfpm.package.name`
- `sfpm.build.success`
- `sfpm.install.success`

## Error Handling

When an event indicates failure (`success === false`):
- Span status is set to `ERROR` with the error message
- `recordException()` is called if an `Error` object is available

## Correlation & Turborepo Compatibility

- `orchestrationId` lives only on orchestration events — core packages have no knowledge of it
- Build/install spans link to an active orchestration span via a fixed parent key; the `SpanEngine` resolves the parent from its active span registry
- **Turbo mode**: when `TURBO_RUN_ID` is detected, the tracer auto-creates a synthetic orchestration root span on `subscribe()`. Build/install spans parent to it just like they would with the native orchestrator. The span ends on `shutdown()`.
- `TURBO_RUN_ID` and `TURBO_HASH` env vars are captured as span attributes for cross-process correlation
- When neither orchestrator nor turbo is active, build/install spans become root spans

## Testing

Use `InMemorySpanExporter` from `@opentelemetry/sdk-trace-node`:

```ts
const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

// ... emit events ...

const spans = exporter.getFinishedSpans();
expect(spans).toHaveLength(1);
expect(spans[0].attributes['sfpm.package.name']).toBe('my-pkg');
```

## Entrypoint Usage

```ts
import { createTracer } from '@b64hub/sfpm-telemetry';

const tracer = createTracer({ serviceName: 'sfpm-cli' });
tracer.subscribe(orchestrator);
const result = await orchestrator.buildAll(packages);
await tracer.shutdown();
```
