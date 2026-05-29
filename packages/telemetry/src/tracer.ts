import {trace} from '@opentelemetry/api';
import {OTLPTraceExporter} from '@opentelemetry/exporter-trace-otlp-http';
import {Resource} from '@opentelemetry/resources';
import {NodeSDK} from '@opentelemetry/sdk-node';
import {ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION} from '@opentelemetry/semantic-conventions';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';

import type {SpanMapping} from './span-map.js';

import type {BusMap} from './span-engine.js';

import {SpanEngine} from './span-engine.js';
import {defaultSpanMappings} from './span-map.js';

export interface TracerOptions {
  /** Custom span mappings (defaults to built-in orchestration/build/install mappings) */
  mappings?: SpanMapping[];
  /** Service name for the OTel resource (e.g. 'sfpm-cli', 'sfpm-actions') */
  serviceName: string;
}

/**
 * Detect service version by walking up from cwd looking for package.json.
 */
function detectServiceVersion(): string | undefined {
  let dir = process.cwd();
  const root = dirname(dir);

  while (dir !== root) {
    try {
      const raw = readFileSync(join(dir, 'package.json'), 'utf8');
      const pkg = JSON.parse(raw) as {version?: string};
      if (pkg.version) return pkg.version;
    } catch {
      // No package.json here, keep walking
    }

    dir = dirname(dir);
  }

  return undefined;
}

/** No-op tracer returned when OTel is not configured. */
const noopTracer: SfpmTracer = {
  async shutdown() {},
  subscribe() {},
};

/**
 * Tracer handle for subscribing to events and shutting down.
 */
export interface SfpmTracer {
  /** Flush pending spans and shut down the OTel SDK. */
  shutdown(): Promise<void>;
  /** Subscribe to typed event buses to produce spans. */
  subscribe(buses: BusMap): void;
}

/**
 * Create an OpenTelemetry tracer backed by the SFPM event system.
 *
 * Tracing is only active when `OTEL_EXPORTER_OTLP_ENDPOINT` is set —
 * otherwise returns a no-op tracer whose methods do nothing.
 */
export function createTracer(options: TracerOptions): SfpmTracer {
  if (!process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    return noopTracer;
  }

  const version = detectServiceVersion();

  const resource = new Resource({
    [ATTR_SERVICE_NAME]: options.serviceName,
    ...(version ? {[ATTR_SERVICE_VERSION]: version} : {}),
  });

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter(),
  });

  sdk.start();

  const otelTracer = trace.getTracer(options.serviceName, version);
  const engine = new SpanEngine(otelTracer, options.mappings ?? defaultSpanMappings);

  let subscribed = false;
  let hasTurboSpan = false;

  return {
    async shutdown() {
      if (hasTurboSpan) {
        engine.endSpan('orchestration');
        hasTurboSpan = false;
      }

      if (subscribed) {
        engine.unsubscribe();
        subscribed = false;
      }

      await sdk.shutdown();
    },
    subscribe(buses: BusMap) {
      engine.subscribe(buses);
      subscribed = true;

      // In turbo mode, auto-create a root orchestration span so build/install
      // spans have a parent. TURBO_RUN_ID correlates spans across processes.
      const turboRunId = process.env.TURBO_RUN_ID;
      if (turboRunId) {
        const rootSpan = otelTracer.startSpan('sfpm.orchestration');
        rootSpan.setAttribute('sfpm.orchestration.mode', 'turbo');
        rootSpan.setAttribute('turbo.run_id', turboRunId);

        const turboHash = process.env.TURBO_HASH;
        if (turboHash) {
          rootSpan.setAttribute('turbo.hash', turboHash);
        }

        engine.registerSpan('orchestration', rootSpan);
        hasTurboSpan = true;
      }
    },
  };
}
