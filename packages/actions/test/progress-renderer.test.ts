import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {EventEmitter} from 'node:events';

import {ActionsProgressRenderer} from '../src/progress-renderer.js';
import {createGitHubActionsLogger, GitHubActionsLogger} from '../src/logger.js';

// Mock @actions/core
vi.mock('@actions/core', () => ({
    debug: vi.fn(),
    endGroup: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    notice: vi.fn(),
    startGroup: vi.fn(),
    warning: vi.fn(),
}));

import * as core from '@actions/core';

describe('ActionsProgressRenderer', () => {
    let logger: GitHubActionsLogger;
    let renderer: ActionsProgressRenderer;

    beforeEach(() => {
        vi.clearAllMocks();
        logger = createGitHubActionsLogger();
        renderer = new ActionsProgressRenderer(logger);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('attachToInstaller', () => {
        it('should log orchestration start immediately', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 3});

            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('3 package(s)'),
            );
        });

        it('should log level heartbeat immediately', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:level:start', {level: 0, packages: ['pkg-a', 'pkg-b']});

            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('Level 0: pkg-a, pkg-b'),
            );
        });

        it('should buffer install events and flush as group on package complete', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            // Buffer events for a package
            emitter.emit('orchestration:package:start', {packageName: 'my-package'});
            emitter.emit('install:start', {packageName: 'my-package', packageType: 'source'});
            emitter.emit('deployment:start', {packageName: 'my-package'});
            emitter.emit('deployment:complete', {componentCount: 42, packageName: 'my-package'});
            emitter.emit('install:complete', {packageName: 'my-package', version: '1.0.0'});

            // Nothing should be written to output yet (only orchestration:start is immediate)
            expect(core.startGroup).not.toHaveBeenCalled();

            // Complete triggers flush
            emitter.emit('orchestration:package:complete', {
                duration: 5000,
                packageName: 'my-package',
                skipped: false,
                success: true,
            });

            // Group should be opened and closed
            expect(core.startGroup).toHaveBeenCalledWith(
                expect.stringContaining('Install: my-package \u2713'),
            );
            expect(core.endGroup).toHaveBeenCalled();

            // Buffered messages should be flushed
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('my-package'),
            );
        });

        it('should show skipped packages as one-liner without group', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:package:start', {packageName: 'my-pkg'});
            emitter.emit('orchestration:package:complete', {
                duration: 0,
                error: 'dependency failed',
                packageName: 'my-pkg',
                skipped: true,
                success: false,
            });

            // Should emit a one-liner, not a group
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('\u2298 Install: my-pkg'),
            );
            expect(core.startGroup).not.toHaveBeenCalled();
        });

        it('should show failed packages with error icon in group header', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:package:start', {packageName: 'fail-pkg'});
            emitter.emit('install:error', {error: 'Deploy failed', packageName: 'fail-pkg'});
            emitter.emit('orchestration:package:complete', {
                duration: 3000,
                error: 'Deploy failed',
                packageName: 'fail-pkg',
                skipped: false,
                success: false,
            });

            expect(core.startGroup).toHaveBeenCalledWith(
                expect.stringContaining('Install: fail-pkg \u2717'),
            );
        });

        it('should include duration in group header', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:package:start', {packageName: 'pkg'});
            emitter.emit('orchestration:package:complete', {
                duration: 12000,
                packageName: 'pkg',
                skipped: false,
                success: true,
            });

            expect(core.startGroup).toHaveBeenCalledWith(
                expect.stringContaining('(12s)'),
            );
        });

        it('should buffer child logger output alongside event messages', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            // Simulate what the orchestrator does: get a child logger
            const childLogger = logger.child({package: 'my-pkg'});

            emitter.emit('orchestration:package:start', {packageName: 'my-pkg'});

            // Core services write to the child logger
            childLogger.info('Resolving dependencies...');
            childLogger.debug('Found 3 dependencies');

            emitter.emit('orchestration:package:complete', {
                duration: 2000,
                packageName: 'my-pkg',
                skipped: false,
                success: true,
            });

            // Child logger messages should be in the flushed group
            expect(core.info).toHaveBeenCalledWith('Resolving dependencies...');
            expect(core.debug).toHaveBeenCalledWith('Found 3 dependencies');
        });
    });

    describe('attachToBuildOrchestrator', () => {
        it('should buffer build events and flush on package complete', () => {
            const emitter = new EventEmitter();
            renderer.attachToBuildOrchestrator(emitter);

            emitter.emit('orchestration:start', {totalPackages: 1});
            emitter.emit('build:start', {packageName: 'core-lib', packageType: 'source'});
            emitter.emit('build:complete', {packageName: 'core-lib', version: '2.0.0'});
            emitter.emit('orchestration:package:complete', {
                duration: 8000,
                packageName: 'core-lib',
                skipped: false,
                success: true,
            });

            expect(core.startGroup).toHaveBeenCalledWith(
                expect.stringContaining('Build: core-lib \u2713 (8s)'),
            );
            expect(core.endGroup).toHaveBeenCalled();
        });
    });

    describe('attachToPoolFetcher', () => {
        it('should log pool fetch lifecycle immediately (not buffered)', () => {
            const emitter = new EventEmitter();
            renderer.attachToPoolFetcher(emitter);

            emitter.emit('pool:fetch:start', {available: 5, tag: 'ci-pool'});
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('5 org(s) available'),
            );

            emitter.emit('pool:fetch:claimed', {username: 'test@org.com'});
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('Claimed org: test@org.com'),
            );

            emitter.emit('pool:fetch:complete', {count: 1});
            expect(core.info).toHaveBeenCalledWith(
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
        it('should create a summary group with package table', () => {
            const emitter = new EventEmitter();
            renderer.attachToInstaller(emitter);

            emitter.emit('orchestration:start', {totalPackages: 2});
            emitter.emit('orchestration:package:start', {packageName: 'pkg-a'});
            emitter.emit('orchestration:package:complete', {
                duration: 5000,
                packageName: 'pkg-a',
                skipped: false,
                success: true,
            });
            emitter.emit('orchestration:package:start', {packageName: 'pkg-b'});
            emitter.emit('orchestration:package:complete', {
                duration: 3000,
                error: 'Deploy failed',
                packageName: 'pkg-b',
                skipped: false,
                success: false,
            });

            renderer.printSummary();

            expect(core.startGroup).toHaveBeenCalledWith(
                expect.stringContaining('Summary'),
            );
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('\u2713 pkg-a'),
            );
            expect(core.info).toHaveBeenCalledWith(
                expect.stringContaining('\u2717 pkg-b'),
            );
            expect(core.endGroup).toHaveBeenCalled();
        });
    });
});
