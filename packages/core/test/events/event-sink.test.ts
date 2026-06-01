import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {ScopedEventSink} from '../../src/events/event-sink.js';
import {TypedEventEmitter} from '../../src/events/typed-event-emitter.js';

interface TestEvents {
  'complete': [{message: string; packageName: string; success: boolean}];
  'start': [{packageName: string; target: string}];
}

describe('ScopedEventSink', () => {
  let bus: TypedEventEmitter<TestEvents>;
  let sink: ScopedEventSink<TestEvents>;

  beforeEach(() => {
    bus = new TypedEventEmitter();
    sink = new ScopedEventSink(bus, 'my-package');
  });

  it('should auto-inject packageName into emitted events', () => {
    const handler = vi.fn();
    bus.on('start', handler);

    sink.emit('start', {target: 'my-org'} as any);

    expect(handler).toHaveBeenCalledOnce();
    const payload = handler.mock.calls[0][0];
    expect(payload.packageName).toBe('my-package');
    expect(payload.target).toBe('my-org');
  });

  it('should not overwrite an explicitly provided packageName', () => {
    const handler = vi.fn();
    bus.on('start', handler);

    sink.emit('start', {packageName: 'override', target: 'org'} as any);

    const payload = handler.mock.calls[0][0];
    // Explicit value wins (spread after auto-injected)
    expect(payload.packageName).toBe('override');
  });

  it('should still receive timestamp from the bus enrichment', () => {
    const handler = vi.fn();
    bus.on('complete', handler);

    sink.emit('complete', {message: 'ok', success: true} as any);

    const payload = handler.mock.calls[0][0];
    expect(payload.packageName).toBe('my-package');
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.message).toBe('ok');
    expect(payload.success).toBe(true);
  });

  it('should handle emit with no arguments', () => {
    const handler = vi.fn();
    bus.on('start', handler);

    // Emit with empty args — scoped sink adds packageName
    sink.emit('start', {} as any);

    const payload = handler.mock.calls[0][0];
    expect(payload.packageName).toBe('my-package');
    expect(payload.timestamp).toBeInstanceOf(Date);
  });
});
