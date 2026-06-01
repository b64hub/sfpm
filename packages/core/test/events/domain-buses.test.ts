import {
  describe, expect, it, vi,
} from 'vitest';

import type {BuildStartEvent, StageStartEvent} from '../../src/events/build-event-bus.js';
import type {DeployStartEvent, InstallStartEvent} from '../../src/events/install-event-bus.js';

import {BuildEventBus, ScopedBuildSink} from '../../src/events/build-event-bus.js';
import {InstallEventBus, ScopedInstallSink} from '../../src/events/install-event-bus.js';
import {PackageType} from '../../src/types/package.js';

describe('BuildEventBus', () => {
  it('should create a ScopedBuildSink via forPackage()', () => {
    const bus = new BuildEventBus();
    const sink = bus.forPackage('pkg-a');

    expect(sink).toBeInstanceOf(ScopedBuildSink);
  });

  it('should auto-inject packageName and timestamp via scoped sink', () => {
    const bus = new BuildEventBus();
    const sink = bus.forPackage('pkg-a');

    const handler = vi.fn();
    bus.on('stage:start', handler);

    sink.emit('stage:start', {stagingDirectory: '/tmp/stage'} as any);

    const payload = handler.mock.calls[0][0] as StageStartEvent;
    expect(payload.packageName).toBe('pkg-a');
    expect(payload.stagingDirectory).toBe('/tmp/stage');
    expect(payload.timestamp).toBeInstanceOf(Date);
  });

  it('should share a single bus across multiple scoped sinks', () => {
    const bus = new BuildEventBus();
    const sinkA = bus.forPackage('pkg-a');
    const sinkB = bus.forPackage('pkg-b');

    const events: StageStartEvent[] = [];
    bus.on('stage:start', (e) => events.push(e));

    sinkA.stageStart({stagingDirectory: '/a'});
    sinkB.stageStart({stagingDirectory: '/b'});

    expect(events).toHaveLength(2);
    expect(events[0].packageName).toBe('pkg-a');
    expect(events[1].packageName).toBe('pkg-b');
  });

  it('should provide convenience methods that emit the correct event', () => {
    const bus = new BuildEventBus();
    const sink = bus.forPackage('my-pkg');

    const startHandler = vi.fn();
    const completeHandler = vi.fn();
    bus.on('start', startHandler);
    bus.on('complete', completeHandler);

    sink.start({packageType: PackageType.Source});
    sink.complete({success: true});

    const startPayload = startHandler.mock.calls[0][0] as BuildStartEvent;
    expect(startPayload.packageName).toBe('my-pkg');
    expect(startPayload.packageType).toBe(PackageType.Source);
    expect(startPayload.timestamp).toBeInstanceOf(Date);

    expect(completeHandler.mock.calls[0][0].success).toBe(true);
  });
});

describe('InstallEventBus', () => {
  it('should create a ScopedInstallSink via forPackage()', () => {
    const bus = new InstallEventBus();
    const sink = bus.forPackage('pkg-install');

    expect(sink).toBeInstanceOf(ScopedInstallSink);
  });

  it('should auto-inject packageName via convenience methods', () => {
    const bus = new InstallEventBus();
    const sink = bus.forPackage('pkg-install');

    const handler = vi.fn();
    bus.on('deploy:start', handler);

    sink.deployStart({targetOrg: 'my-org'});

    const payload = handler.mock.calls[0][0] as DeployStartEvent;
    expect(payload.packageName).toBe('pkg-install');
    expect(payload.targetOrg).toBe('my-org');
    expect(payload.timestamp).toBeInstanceOf(Date);
  });

  it('should provide start/complete/skip convenience methods', () => {
    const bus = new InstallEventBus();
    const sink = bus.forPackage('install-pkg');

    const startHandler = vi.fn();
    const skipHandler = vi.fn();
    bus.on('start', startHandler);
    bus.on('skip', skipHandler);

    sink.start({packageType: PackageType.Unlocked, targetOrg: 'org-1'});
    sink.skip({packageType: PackageType.Unlocked, targetOrg: 'org-1', reason: 'already-installed'});

    const startPayload = startHandler.mock.calls[0][0] as InstallStartEvent;
    expect(startPayload.packageName).toBe('install-pkg');
    expect(startPayload.packageType).toBe(PackageType.Unlocked);

    expect(skipHandler.mock.calls[0][0].reason).toBe('already-installed');
  });
});
