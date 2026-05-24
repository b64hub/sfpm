import type EventEmitter from 'node:events';

import {
  context, type Span, SpanStatusCode, trace, type Tracer,
} from '@opentelemetry/api';

import type {SpanMapping} from './span-map.js';

/**
 * Subscribes to EventEmitter events and translates them into OpenTelemetry spans
 * using a declarative {@link SpanMapping} registry.
 */
export class SpanEngine {
  private readonly activeSpans = new Map<string, Span>();
  private readonly listeners: Array<{event: string; fn: (...args: any[]) => void}> = [];
  private readonly mappings: SpanMapping[];
  private readonly tracer: Tracer;

  constructor(tracer: Tracer, mappings: SpanMapping[]) {
    this.tracer = tracer;
    this.mappings = mappings;
  }

  /**
   * Subscribe to all mapped events on the given emitter.
   */
  subscribe(emitter: EventEmitter): void {
    for (const mapping of this.mappings) {
      const startFn = (evt: Record<string, unknown>) => this.onStartEvent(mapping, evt);
      const endFn = (evt: Record<string, unknown>) => this.onEndEvent(mapping, evt);

      emitter.on(mapping.start, startFn);
      emitter.on(mapping.end, endFn);

      this.listeners.push(
        {event: mapping.start, fn: startFn},
        {event: mapping.end, fn: endFn},
      );
    }
  }

  /**
   * Unsubscribe all listeners from the emitter.
   */
  unsubscribe(emitter: EventEmitter): void {
    for (const {event, fn} of this.listeners) {
      emitter.removeListener(event, fn);
    }

    this.listeners.length = 0;
  }

  private onEndEvent(mapping: SpanMapping, evt: Record<string, unknown>): void {
    const key = mapping.spanKey(evt);
    const span = this.activeSpans.get(key);
    if (!span) return;

    if (mapping.endAttributes) {
      const attrs = mapping.endAttributes(evt);
      for (const [attrKey, value] of Object.entries(attrs)) {
        span.setAttribute(attrKey, value);
      }
    }

    // Set error status when the event indicates failure
    if (evt.success === false) {
      const errorMessage = typeof evt.error === 'string' ? evt.error : undefined;
      span.setStatus({code: SpanStatusCode.ERROR, message: errorMessage});

      if (evt.error instanceof Error) {
        span.recordException(evt.error);
      } else if (errorMessage) {
        span.recordException(new Error(errorMessage));
      }
    }

    span.end();
    this.activeSpans.delete(key);
  }

  private onStartEvent(mapping: SpanMapping, evt: Record<string, unknown>): void {
    const key = mapping.spanKey(evt);

    let parentCtx = context.active();
    if (mapping.parentKey) {
      const parentKey = mapping.parentKey(evt);
      if (parentKey) {
        const parentSpan = this.activeSpans.get(parentKey);
        if (parentSpan) {
          parentCtx = trace.setSpan(context.active(), parentSpan);
        }
      }
    }

    const span = this.tracer.startSpan(mapping.name, undefined, parentCtx);

    if (mapping.startAttributes) {
      const attrs = mapping.startAttributes(evt);
      for (const [attrKey, value] of Object.entries(attrs)) {
        span.setAttribute(attrKey, value);
      }
    }

    this.activeSpans.set(key, span);
  }
}
