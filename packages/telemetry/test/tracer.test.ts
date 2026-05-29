import EventEmitter from 'node:events';

import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {createTracer} from '../src/tracer.js';

describe('createTracer', () => {
  const originalEnv = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

  beforeEach(() => {
    delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.OTEL_EXPORTER_OTLP_ENDPOINT = originalEnv;
    } else {
      delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    }
  });

  it('should return a no-op tracer when OTEL_EXPORTER_OTLP_ENDPOINT is not set', async () => {
    const tracer = createTracer({serviceName: 'test'});
    const buses = {
      build: new EventEmitter(),
      orchestration: new EventEmitter(),
    };

    tracer.subscribe(buses);
    await expect(tracer.shutdown()).resolves.toBeUndefined();
    expect(buses.orchestration.listenerCount('start')).toBe(0);
  });

  it('should not attach listeners on subscribe when OTEL_EXPORTER_OTLP_ENDPOINT is not set', () => {
    const tracer = createTracer({serviceName: 'test'});
    const buses = {
      build: new EventEmitter(),
      install: new EventEmitter(),
      orchestration: new EventEmitter(),
    };

    tracer.subscribe(buses);

    expect(buses.orchestration.listenerCount('start')).toBe(0);
    expect(buses.build.listenerCount('start')).toBe(0);
    expect(buses.install.listenerCount('start')).toBe(0);
  });

  it('should attach listeners on subscribe when OTEL_EXPORTER_OTLP_ENDPOINT is set', () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const tracer = createTracer({serviceName: 'test'});
    const buses = {
      build: new EventEmitter(),
      install: new EventEmitter(),
      orchestration: new EventEmitter(),
    };

    tracer.subscribe(buses);

    expect(buses.orchestration.listenerCount('start')).toBe(1);
    expect(buses.orchestration.listenerCount('complete')).toBe(1);
    expect(buses.build.listenerCount('start')).toBe(1);
    expect(buses.build.listenerCount('complete')).toBe(1);
    expect(buses.install.listenerCount('start')).toBe(1);
    expect(buses.install.listenerCount('complete')).toBe(1);

    tracer.shutdown().catch(() => {});
  });

  it('should remove listeners on shutdown', async () => {
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://localhost:4318';
    const tracer = createTracer({serviceName: 'test'});
    const buses = {
      build: new EventEmitter(),
      install: new EventEmitter(),
      orchestration: new EventEmitter(),
    };

    tracer.subscribe(buses);
    expect(buses.orchestration.listenerCount('start')).toBe(1);

    try {
      await tracer.shutdown();
    } catch {
      // SDK shutdown may fail without real exporter — that's OK
    }

    expect(buses.orchestration.listenerCount('start')).toBe(0);
    expect(buses.build.listenerCount('start')).toBe(0);
    expect(buses.install.listenerCount('start')).toBe(0);
  });
});
