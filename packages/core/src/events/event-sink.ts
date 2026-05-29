import type {TypedEventEmitter} from './typed-event-emitter.js';

/**
 * Write-only event interface for producers.
 *
 * Builders, installers, and other internal components receive an
 * `EventSink` instead of the full bus — they can emit events but
 * cannot subscribe. This enforces a clean producer/consumer split.
 */
export interface EventSink<T extends {[K in keyof T]: unknown[]}> {
  emit<K extends keyof T & string>(event: K, ...args: T[K]): void;
}

/**
 * A scoped event sink that auto-injects a fixed `packageName`
 * into every emitted event payload.
 *
 * Created via `bus.forPackage(name)` — builders receive this so they
 * never need to pass `packageName` manually.
 */
export class ScopedEventSink<T extends {[K in keyof T]: unknown[]}> implements EventSink<T> {
  private readonly bus: TypedEventEmitter<T>;
  private readonly packageName: string;

  constructor(bus: TypedEventEmitter<T>, packageName: string) {
    this.bus = bus;
    this.packageName = packageName;
  }

  emit<K extends keyof T & string>(event: K, ...args: T[K]): void {
    const enriched = this.enrichArgs(args);
    this.bus.emit(event, ...(enriched as T[K]));
  }

  private enrichArgs(args: unknown[]): unknown[] {
    if (args.length === 0) return [{packageName: this.packageName}];

    const first = args[0];
    if (first !== null && typeof first === 'object' && !Array.isArray(first)) {
      return [{packageName: this.packageName, ...first as Record<string, unknown>}, ...args.slice(1)];
    }

    return args;
  }
}
