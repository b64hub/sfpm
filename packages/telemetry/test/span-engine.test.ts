import EventEmitter from 'node:events';

import {SpanStatusCode} from '@opentelemetry/api';
import {InMemorySpanExporter, SimpleSpanProcessor} from '@opentelemetry/sdk-trace-node';
import {NodeTracerProvider} from '@opentelemetry/sdk-trace-node';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {SpanEngine} from '../src/span-engine.js';
import {defaultSpanMappings} from '../src/span-map.js';

import type {SpanMapping} from '../src/span-map.js';

describe('SpanEngine', () => {
  let exporter: InMemorySpanExporter;
  let provider: NodeTracerProvider;
  let emitter: EventEmitter;
  let engine: SpanEngine;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
    provider.register();

    const tracer = provider.getTracer('test');
    engine = new SpanEngine(tracer, defaultSpanMappings);
    emitter = new EventEmitter();
    engine.subscribe(emitter);
  });

  afterEach(async () => {
    engine.unsubscribe(emitter);
    await provider.shutdown();
  });

  describe('orchestration spans', () => {
    it('should create an orchestration root span', () => {
      const orchestrationId = 'test-orch-1';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: ['pkg-a', 'pkg-b'],
        timestamp: new Date(),
        totalLevels: 2,
        totalPackages: 2,
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 5000,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(1);

      const span = spans[0];
      expect(span.name).toBe('sfpm.orchestration');
      expect(span.attributes['sfpm.orchestration.id']).toBe(orchestrationId);
      expect(span.attributes['sfpm.orchestration.total_packages']).toBe(2);
      expect(span.attributes['sfpm.orchestration.total_levels']).toBe(2);
      expect(span.attributes['sfpm.orchestration.include_dependencies']).toBe(true);
      expect(span.attributes['sfpm.orchestration.total_duration_ms']).toBe(5000);
    });

    it('should not create a span if only start event fires', () => {
      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId: 'test-orch-2',
        packageNames: [],
        timestamp: new Date(),
        totalLevels: 0,
        totalPackages: 0,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(0);
    });
  });

  describe('build spans', () => {
    it('should create a build span as child of orchestration', () => {
      const orchestrationId = 'test-orch-3';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: ['pkg-a'],
        timestamp: new Date(),
        totalLevels: 1,
        totalPackages: 1,
      });

      emitter.emit('build:start', {
        orchestrationId,
        packageName: 'pkg-a',
        packageType: 'source',
        timestamp: new Date(),
      });

      emitter.emit('build:complete', {
        orchestrationId,
        packageName: 'pkg-a',
        success: true,
        timestamp: new Date(),
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 3000,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);

      const buildSpan = spans.find(s => s.name === 'sfpm.build')!;
      const orchSpan = spans.find(s => s.name === 'sfpm.orchestration')!;

      expect(buildSpan).toBeDefined();
      expect(orchSpan).toBeDefined();
      expect(buildSpan.attributes['sfpm.package.name']).toBe('pkg-a');
      expect(buildSpan.attributes['sfpm.package.type']).toBe('source');
      expect(buildSpan.attributes['sfpm.build.success']).toBe(true);

      // Verify parent-child relationship
      expect(buildSpan.parentSpanId).toBe(orchSpan.spanContext().spanId);
    });

    it('should set ERROR status on failed build', () => {
      const orchestrationId = 'test-orch-4';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: ['pkg-b'],
        timestamp: new Date(),
        totalLevels: 1,
        totalPackages: 1,
      });

      emitter.emit('build:start', {
        orchestrationId,
        packageName: 'pkg-b',
        packageType: 'unlocked',
        timestamp: new Date(),
      });

      emitter.emit('build:complete', {
        error: 'Package creation failed',
        orchestrationId,
        packageName: 'pkg-b',
        success: false,
        timestamp: new Date(),
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 1000,
      });

      const spans = exporter.getFinishedSpans();
      const buildSpan = spans.find(s => s.name === 'sfpm.build')!;

      expect(buildSpan.status.code).toBe(SpanStatusCode.ERROR);
      expect(buildSpan.status.message).toBe('Package creation failed');
      expect(buildSpan.events).toHaveLength(1);
      expect(buildSpan.events[0].name).toBe('exception');
    });

    it('should record Error object as exception', () => {
      const orchestrationId = 'test-orch-5';

      emitter.emit('build:start', {
        orchestrationId,
        packageName: 'pkg-c',
        packageType: 'source',
        timestamp: new Date(),
      });

      const error = new Error('Something went wrong');
      emitter.emit('build:complete', {
        error,
        orchestrationId,
        packageName: 'pkg-c',
        success: false,
        timestamp: new Date(),
      });

      const spans = exporter.getFinishedSpans();
      const buildSpan = spans.find(s => s.name === 'sfpm.build')!;
      expect(buildSpan.status.code).toBe(SpanStatusCode.ERROR);
      expect(buildSpan.events[0].name).toBe('exception');
    });
  });

  describe('install spans', () => {
    it('should create an install span as child of orchestration', () => {
      const orchestrationId = 'test-orch-6';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: ['pkg-d'],
        timestamp: new Date(),
        totalLevels: 1,
        totalPackages: 1,
      });

      emitter.emit('install:start', {
        orchestrationId,
        packageName: 'pkg-d',
        timestamp: new Date(),
      });

      emitter.emit('install:complete', {
        orchestrationId,
        packageName: 'pkg-d',
        success: true,
        timestamp: new Date(),
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 2000,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);

      const installSpan = spans.find(s => s.name === 'sfpm.install')!;
      const orchSpan = spans.find(s => s.name === 'sfpm.orchestration')!;

      expect(installSpan.attributes['sfpm.package.name']).toBe('pkg-d');
      expect(installSpan.attributes['sfpm.install.success']).toBe(true);
      expect(installSpan.parentSpanId).toBe(orchSpan.spanContext().spanId);
    });
  });

  describe('span lifecycle', () => {
    it('should clean up completed spans from registry', () => {
      const orchestrationId = 'test-orch-7';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: [],
        timestamp: new Date(),
        totalLevels: 0,
        totalPackages: 0,
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 100,
      });

      // Second orchestration with same ID pattern — should create a new span
      const orchestrationId2 = 'test-orch-8';

      emitter.emit('orchestration:start', {
        includeDependencies: false,
        orchestrationId: orchestrationId2,
        packageNames: [],
        timestamp: new Date(),
        totalLevels: 0,
        totalPackages: 0,
      });

      emitter.emit('orchestration:complete', {
        orchestrationId: orchestrationId2,
        results: [],
        timestamp: new Date(),
        totalDuration: 200,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(2);
    });

    it('should handle end event without matching start gracefully', () => {
      emitter.emit('orchestration:complete', {
        orchestrationId: 'nonexistent',
        results: [],
        timestamp: new Date(),
        totalDuration: 0,
      });

      const spans = exporter.getFinishedSpans();
      expect(spans).toHaveLength(0);
    });

    it('should handle multiple concurrent build spans', () => {
      const orchestrationId = 'test-orch-9';

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId,
        packageNames: ['pkg-a', 'pkg-b'],
        timestamp: new Date(),
        totalLevels: 1,
        totalPackages: 2,
      });

      // Start both builds concurrently
      emitter.emit('build:start', {
        orchestrationId,
        packageName: 'pkg-a',
        packageType: 'source',
        timestamp: new Date(),
      });

      emitter.emit('build:start', {
        orchestrationId,
        packageName: 'pkg-b',
        packageType: 'unlocked',
        timestamp: new Date(),
      });

      // Complete them in reverse order
      emitter.emit('build:complete', {
        orchestrationId,
        packageName: 'pkg-b',
        success: true,
        timestamp: new Date(),
      });

      emitter.emit('build:complete', {
        orchestrationId,
        packageName: 'pkg-a',
        success: true,
        timestamp: new Date(),
      });

      emitter.emit('orchestration:complete', {
        orchestrationId,
        results: [],
        timestamp: new Date(),
        totalDuration: 5000,
      });

      const spans = exporter.getFinishedSpans();
      const buildSpans = spans.filter(s => s.name === 'sfpm.build');
      expect(buildSpans).toHaveLength(2);

      const pkgASpan = buildSpans.find(s => s.attributes['sfpm.package.name'] === 'pkg-a')!;
      const pkgBSpan = buildSpans.find(s => s.attributes['sfpm.package.name'] === 'pkg-b')!;
      expect(pkgASpan).toBeDefined();
      expect(pkgBSpan).toBeDefined();
    });
  });

  describe('unsubscribe', () => {
    it('should stop creating spans after unsubscribe', () => {
      engine.unsubscribe(emitter);

      emitter.emit('orchestration:start', {
        includeDependencies: true,
        orchestrationId: 'after-unsub',
        packageNames: [],
        timestamp: new Date(),
        totalLevels: 0,
        totalPackages: 0,
      });

      emitter.emit('orchestration:complete', {
        orchestrationId: 'after-unsub',
        results: [],
        timestamp: new Date(),
        totalDuration: 0,
      });

      expect(exporter.getFinishedSpans()).toHaveLength(0);
    });
  });
});

describe('SpanEngine with custom mappings', () => {
  it('should work with custom span mappings', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new NodeTracerProvider();
    provider.addSpanProcessor(new SimpleSpanProcessor(exporter));

    const tracer = provider.getTracer('custom-test');
    const customMapping: SpanMapping = {
      end: 'custom:end',
      name: 'custom.operation',
      spanKey: (evt) => `custom:${evt.id as string}`,
      start: 'custom:start',
      startAttributes: (evt) => ({'custom.id': evt.id as string}),
    };

    const engine = new SpanEngine(tracer, [customMapping]);
    const emitter = new EventEmitter();
    engine.subscribe(emitter);

    emitter.emit('custom:start', {id: 'op-1'});
    emitter.emit('custom:end', {id: 'op-1', success: true});

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('custom.operation');
    expect(spans[0].attributes['custom.id']).toBe('op-1');

    engine.unsubscribe(emitter);
    await provider.shutdown();
  });
});
