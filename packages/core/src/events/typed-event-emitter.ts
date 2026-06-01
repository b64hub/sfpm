import EventEmitter from 'node:events';

/**
 * Generic type-safe event emitter that extends Node's {@link EventEmitter}.
 *
 * Auto-injects `timestamp: Date` into every emitted event payload.
 * Subclasses (e.g. {@link OrchestrationEventBus}) can override
 * {@link enrichPayload} to inject additional fields.
 *
 * @typeParam T - Event map where keys are event names and values are
 *               tuples of the payload type: `{ 'start': [StartEvent] }`
 */
export class TypedEventEmitter<T extends {[K in keyof T]: unknown[]}> extends EventEmitter {
  /**
   * Emit a typed event. The payload is enriched with `{ timestamp }` before
   * being forwarded to listeners.
   */
  override emit<K extends keyof T & string>(event: K, ...args: T[K]): boolean {
    const enriched = this.enrichPayload(args);
    return super.emit(event, ...enriched);
  }

  /**
   * Enrich event arguments before emission.
   * Default: merges `{ timestamp: new Date() }` into the first argument
   * if it is a plain object.
   *
   * Subclasses override this to inject domain-specific fields
   * (e.g. `orchestrationId`).
   */
  protected enrichPayload(args: unknown[]): unknown[] {
    if (args.length === 0) return [{timestamp: new Date()}];

    const first = args[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      return [{timestamp: new Date(), ...first as Record<string, unknown>}, ...args.slice(1)];
    }

    return args;
  }

  /** Return the number of listeners for the given event. */
  override listenerCount<K extends keyof T & string>(event: K): number {
    return super.listenerCount(event);
  }

  /** Unsubscribe from a typed event. */
  override off<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.off(event, listener as (...args: any[]) => void);
  }

  /** Subscribe to a typed event. */
  override on<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.on(event, listener as (...args: any[]) => void);
  }

  /** Subscribe to a typed event — fires once then auto-removes. */
  override once<K extends keyof T & string>(event: K, listener: (...args: T[K]) => void): this {
    return super.once(event, listener as (...args: any[]) => void);
  }

  /** Remove all listeners (optionally for a specific event). */
  override removeAllListeners<K extends keyof T & string>(event?: K): this {
    if (event !== undefined) {
      return super.removeAllListeners(event);
    }

    return super.removeAllListeners();
  }
}
