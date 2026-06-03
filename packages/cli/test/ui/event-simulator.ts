import type {TypedEventEmitter} from '@b64hub/sfpm-core';

// ============================================================================
// Types
// ============================================================================

/**
 * A single entry in a simulation timeline.
 *
 * @typeParam TEvents - The event map of the target emitter
 */
export interface TimelineEntry<TEvents extends {[K in keyof TEvents]: unknown[]}> {
  /** Delay in milliseconds before emitting this event */
  delay: number;
  /** The event name to emit */
  event: keyof TEvents & string;
  /** The payload to emit (first element of the args tuple) */
  payload: TEvents[keyof TEvents & string] extends [infer P, ...unknown[]] ? P : never;
}

export interface SimulatorOptions {
  /** Playback speed multiplier (default: 1). Use 0 for instant. */
  speed?: number;
}

// ============================================================================
// EventSimulator
// ============================================================================

/**
 * Generic event simulator for visual testing of event-driven UI renderers.
 *
 * Plays a timeline of typed events through any {@link TypedEventEmitter},
 * allowing fast iteration on renderer output without running real backends.
 *
 * @example
 * ```ts
 * const bus = new ValidationEventBus();
 * const simulator = new EventSimulator(bus);
 * renderer.attachTo(bus);
 *
 * await simulator.play([
 *   { delay: 0,    event: 'resolve:start',  payload: { packageNames: ['pkg-a'] } },
 *   { delay: 1000, event: 'resolve:status', payload: { status: 'polling' } },
 *   { delay: 2000, event: 'resolve:passed', payload: { checks: ['deploy'], codeCoverage: 85 } },
 *   { delay: 500,  event: 'resolve:complete', payload: { total: 1, passed: 1, failed: 0, timedOut: 0 } },
 * ], { speed: 2 });
 * ```
 */
export class EventSimulator<TEvents extends {[K in keyof TEvents]: unknown[]}> {
  private readonly emitter: TypedEventEmitter<TEvents>;

  constructor(emitter: TypedEventEmitter<TEvents>) {
    this.emitter = emitter;
  }

  /**
   * Play a timeline of events sequentially with delays.
   */
  async play(timeline: TimelineEntry<TEvents>[], options?: SimulatorOptions): Promise<void> {
    const speed = options?.speed ?? 1;

    for (const entry of timeline) {
      const effectiveDelay = speed === 0 ? 0 : Math.round(entry.delay / speed);

      if (effectiveDelay > 0) {
        // eslint-disable-next-line no-await-in-loop -- intentionally sequential
        await new Promise(resolve => {
          setTimeout(resolve, effectiveDelay);
        });
      }

      this.emitter.emit(entry.event as any, entry.payload as any);
    }
  }
}
