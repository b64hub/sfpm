import {
  describe, expect, it, vi,
} from 'vitest';

import type {OrchestrationStartEvent} from '../../src/events/orchestration-event-bus.js';

import {OrchestrationEventBus} from '../../src/events/orchestration-event-bus.js';

describe('OrchestrationEventBus', () => {
  it('should auto-inject orchestrationId into every emitted event', () => {
    const bus = new OrchestrationEventBus('orch-123');
    const handler = vi.fn();

    bus.on('start', handler);
    bus.emit('start', {
      includeDependencies: false,
      packageNames: ['a', 'b'],
      totalLevels: 1,
      totalPackages: 2,
    } as any);

    const payload = handler.mock.calls[0][0] as OrchestrationStartEvent;
    expect(payload.orchestrationId).toBe('orch-123');
    expect(payload.packageNames).toEqual(['a', 'b']);
    expect(payload.totalPackages).toBe(2);
  });

  it('should auto-inject timestamp alongside orchestrationId', () => {
    const bus = new OrchestrationEventBus('orch-456');
    const handler = vi.fn();

    bus.on('complete', handler);
    bus.emit('complete', {results: [], totalDuration: 1000} as any);

    const payload = handler.mock.calls[0][0];
    expect(payload.orchestrationId).toBe('orch-456');
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.results).toEqual([]);
  });

  it('should expose orchestrationId via getter', () => {
    const bus = new OrchestrationEventBus('orch-789');
    expect(bus.getOrchestrationId()).toBe('orch-789');
  });

  it('should not overwrite an explicitly provided orchestrationId', () => {
    const bus = new OrchestrationEventBus('auto-id');
    const handler = vi.fn();

    bus.on('start', handler);
    bus.emit('start', {
      includeDependencies: false,
      orchestrationId: 'explicit-id',
      packageNames: [],
      totalLevels: 0,
      totalPackages: 0,
    } as any);

    const payload = handler.mock.calls[0][0];
    expect(payload.orchestrationId).toBe('explicit-id');
  });

  it('should provide convenience methods', () => {
    const bus = new OrchestrationEventBus('conv-123');
    const handler = vi.fn();

    bus.on('start', handler);

    bus.start({
      includeDependencies: true,
      packageNames: ['x', 'y'],
      totalLevels: 2,
      totalPackages: 3,
    });

    const payload = handler.mock.calls[0][0] as OrchestrationStartEvent;
    expect(payload.orchestrationId).toBe('conv-123');
    expect(payload.timestamp).toBeInstanceOf(Date);
    expect(payload.packageNames).toEqual(['x', 'y']);
  });

  it('should provide levelStart/levelComplete convenience methods', () => {
    const bus = new OrchestrationEventBus('level-test');

    const levelStartHandler = vi.fn();
    const levelCompleteHandler = vi.fn();
    bus.on('level:start', levelStartHandler);
    bus.on('level:complete', levelCompleteHandler);

    bus.levelStart({level: 1, packages: ['a'], packageDetails: [{name: 'a', isManaged: false}]});
    bus.levelComplete({level: 1, succeeded: ['a'], failed: [], skipped: []});

    expect(levelStartHandler.mock.calls[0][0].orchestrationId).toBe('level-test');
    expect(levelStartHandler.mock.calls[0][0].level).toBe(1);
    expect(levelCompleteHandler.mock.calls[0][0].succeeded).toEqual(['a']);
  });
});
