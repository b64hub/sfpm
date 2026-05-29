import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {TypedEventEmitter} from '../../src/events/typed-event-emitter.js';

interface TestEvents {
  'complete': [{message: string; success: boolean}];
  'progress': [{percent: number}];
  'simple': [];
}

describe('TypedEventEmitter', () => {
  let emitter: TypedEventEmitter<TestEvents>;

  beforeEach(() => {
    emitter = new TypedEventEmitter();
  });

  describe('emit and on', () => {
    it('should deliver typed events to listeners', () => {
      const handler = vi.fn();
      emitter.on('complete', handler);

      emitter.emit('complete', {message: 'done', success: true});

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({message: 'done', success: true}),
      );
    });

    it('should auto-inject timestamp into event payload', () => {
      const handler = vi.fn();
      emitter.on('progress', handler);

      const before = new Date();
      emitter.emit('progress', {percent: 50});
      const after = new Date();

      const payload = handler.mock.calls[0][0];
      expect(payload.timestamp).toBeInstanceOf(Date);
      expect(payload.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(payload.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it('should not overwrite an explicitly provided timestamp', () => {
      const handler = vi.fn();
      emitter.on('progress', handler);

      const explicit = new Date('2020-01-01');
      emitter.emit('progress', {percent: 75, timestamp: explicit} as any);

      const payload = handler.mock.calls[0][0];
      // Explicit timestamp wins (spread after auto-injected)
      expect(payload.timestamp).toBe(explicit);
    });

    it('should handle events with no payload', () => {
      const handler = vi.fn();
      emitter.on('simple', handler);

      emitter.emit('simple');

      expect(handler).toHaveBeenCalledOnce();
      const payload = handler.mock.calls[0][0];
      expect(payload.timestamp).toBeInstanceOf(Date);
    });
  });

  describe('once', () => {
    it('should fire once then auto-remove', () => {
      const handler = vi.fn();
      emitter.once('progress', handler);

      emitter.emit('progress', {percent: 10});
      emitter.emit('progress', {percent: 20});

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('off', () => {
    it('should remove a specific listener', () => {
      const handler = vi.fn();
      emitter.on('progress', handler);
      emitter.off('progress', handler);

      emitter.emit('progress', {percent: 10});

      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe('removeAllListeners', () => {
    it('should remove all listeners for a specific event', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('progress', h1);
      emitter.on('complete', h2);

      emitter.removeAllListeners('progress');
      emitter.emit('progress', {percent: 10});
      emitter.emit('complete', {message: 'ok', success: true});

      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledOnce();
    });

    it('should remove all listeners when no event specified', () => {
      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('progress', h1);
      emitter.on('complete', h2);

      emitter.removeAllListeners();
      emitter.emit('progress', {percent: 10});
      emitter.emit('complete', {message: 'ok', success: true});

      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });
  });

  describe('listenerCount', () => {
    it('should return the number of listeners for an event', () => {
      expect(emitter.listenerCount('progress')).toBe(0);

      const h1 = vi.fn();
      const h2 = vi.fn();
      emitter.on('progress', h1);
      emitter.on('progress', h2);

      expect(emitter.listenerCount('progress')).toBe(2);
    });
  });

  describe('chaining', () => {
    it('should support method chaining', () => {
      const handler = vi.fn();
      const result = emitter.on('progress', handler).on('complete', handler);
      expect(result).toBe(emitter);
    });
  });
});
