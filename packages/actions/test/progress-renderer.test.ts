import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';

import {ActionsProgressRenderer} from '../src/progress-renderer.js';

describe('ActionsProgressRenderer', () => {
    let mockLogger: any;
    let renderer: ActionsProgressRenderer;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLogger = {
            debug: vi.fn(),
            error: vi.fn(),
            group: vi.fn(),
            groupEnd: vi.fn(),
            info: vi.fn(),
            log: vi.fn(),
            trace: vi.fn(),
            warn: vi.fn(),
        };
        renderer = new ActionsProgressRenderer(mockLogger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('attachToInstaller', () => {
        it('should log orchestration start', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 3});

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('3 package(s)'),
            );
        });

        it('should create log groups for each package', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:package:start', {packageName: 'my-package'});
            expect(mockLogger.group).toHaveBeenCalledWith('Install: my-package');

            emitter.emit('orchestration:package:complete', {packageName: 'my-package'});
            expect(mockLogger.groupEnd).toHaveBeenCalled();
        });

        it('should log install events', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('install:start', {packageName: 'pkg', packageType: 'source'});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('pkg'),
            );
        });

        it('should log deployment events', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('deployment:start', {});
            expect(mockLogger.info).toHaveBeenCalledWith('Source deployment started');

            emitter.emit('deployment:complete', {componentCount: 42});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('42 components'),
            );
        });

        it('should log skip events', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('install:skip', {packageName: 'pkg', reason: 'already installed'});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Skipped: pkg'),
            );
        });

        it('should log error events', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('install:error', {error: 'Deployment failed', packageName: 'pkg'});
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Failed: pkg'),
            );
        });
    });

    describe('attachToPoolFetcher', () => {
        it('should log pool fetch lifecycle', () => {
            const emitter = new EventEmitter();
            renderer.attachToPoolFetcher(emitter);

            emitter.emit('pool:fetch:start', {available: 5, tag: 'ci-pool'});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('5 org(s) available'),
            );

            emitter.emit('pool:fetch:claimed', {username: 'test@org.com'});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Claimed org: test@org.com'),
            );

            emitter.emit('pool:fetch:complete', {count: 1});
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Pool fetch complete'),
            );
        });
    });

    describe('event log', () => {
        it('should collect all events', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 2});
            emitter.emit('install:start', {packageName: 'pkg-a'});
            emitter.emit('install:complete', {packageName: 'pkg-a', version: '1.0.0'});

            const events = renderer.getEventLog();
            expect(events).toHaveLength(3);
            expect(events[0].type).toBe('orchestration:start');
            expect(events[1].type).toBe('install:start');
            expect(events[2].type).toBe('install:complete');
        });
    });

    describe('printSummary', () => {
        it('should print summary with error count', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 2});
            emitter.emit('install:error', {error: 'boom', packageName: 'pkg-a'});
            emitter.emit('orchestration:complete', {});

            renderer.printSummary();

            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Total events: 3'),
            );
            expect(mockLogger.error).toHaveBeenCalledWith(
                expect.stringContaining('Errors: 1'),
            );
        });

        it('should use log groups for summary when available', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 1});
            renderer.printSummary();

            expect(mockLogger.group).toHaveBeenCalledWith('Summary');
            expect(mockLogger.groupEnd).toHaveBeenCalled();
        });
    });

    describe('falls back gracefully without StructuredLogger', () => {
        it('should use plain info for package headers when no group support', () => {
            const plainLogger = {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                log: vi.fn(),
                trace: vi.fn(),
                warn: vi.fn(),
            };
            const plainRenderer = new ActionsProgressRenderer(plainLogger);
            const emitter = new EventEmitter();
            plainRenderer.attachToInstaller(emitter);

            emitter.emit('orchestration:package:start', {packageName: 'my-pkg'});

            expect(plainLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('--- Installing: my-pkg ---'),
            );
        });
    });
});
