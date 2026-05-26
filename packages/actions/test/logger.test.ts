import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {GitHubActionsLogger, createGitHubActionsLogger} from '../src/logger.js';

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

describe('GitHubActionsLogger', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('createGitHubActionsLogger', () => {
        it('should create a logger instance', () => {
            const logger = createGitHubActionsLogger();
            expect(logger).toBeInstanceOf(GitHubActionsLogger);
        });

        it('should create a logger with prefix', () => {
            const logger = createGitHubActionsLogger({prefix: 'test'});
            expect(logger).toBeInstanceOf(GitHubActionsLogger);
        });
    });

    describe('log levels', () => {
        it('should map info() to core.info()', () => {
            const logger = createGitHubActionsLogger();
            logger.info('info message');
            expect(core.info).toHaveBeenCalledWith('info message');
        });

        it('should map warn() to core.warning()', () => {
            const logger = createGitHubActionsLogger();
            logger.warn('warning message');
            expect(core.warning).toHaveBeenCalledWith('warning message');
        });

        it('should map error() to core.error()', () => {
            const logger = createGitHubActionsLogger();
            logger.error('error message');
            expect(core.error).toHaveBeenCalledWith('error message');
        });

        it('should map debug() to core.debug()', () => {
            const logger = createGitHubActionsLogger();
            logger.debug('debug message');
            expect(core.debug).toHaveBeenCalledWith('debug message');
        });

        it('should map trace() to core.debug() with prefix', () => {
            const logger = createGitHubActionsLogger();
            logger.trace('trace message');
            expect(core.debug).toHaveBeenCalledWith('[trace] trace message');
        });
    });

    describe('prefix', () => {
        it('should prepend prefix to all messages', () => {
            const logger = createGitHubActionsLogger({prefix: 'my-action'});

            logger.info('test');
            expect(core.info).toHaveBeenCalledWith('[my-action] test');

            logger.warn('warning');
            expect(core.warning).toHaveBeenCalledWith('[my-action] warning');

            logger.error('error');
            expect(core.error).toHaveBeenCalledWith('[my-action] error');

            logger.debug('debug');
            expect(core.debug).toHaveBeenCalledWith('[my-action] debug');
        });
    });

    describe('structured output', () => {
        it('should support group/groupEnd', () => {
            const logger = createGitHubActionsLogger();

            logger.group('My Group');
            expect(core.startGroup).toHaveBeenCalledWith('My Group');

            logger.groupEnd();
            expect(core.endGroup).toHaveBeenCalled();
        });

        it('should prepend prefix to group labels', () => {
            const logger = createGitHubActionsLogger({prefix: 'deploy'});

            logger.group('Step 1');
            expect(core.startGroup).toHaveBeenCalledWith('[deploy] Step 1');
        });

        it('should support annotate with error level', () => {
            const logger = createGitHubActionsLogger();

            logger.annotate('error', 'Deployment failed', {
                file: 'force-app/main/default/classes/MyClass.cls',
                line: 42,
                title: 'Compile Error',
            });

            expect(core.error).toHaveBeenCalledWith('Deployment failed', {
                file: 'force-app/main/default/classes/MyClass.cls',
                startLine: 42,
                title: 'Compile Error',
            });
        });

        it('should support annotate with warning level', () => {
            const logger = createGitHubActionsLogger();

            logger.annotate('warning', 'Deprecated API', {
                file: 'src/classes/Old.cls',
                line: 10,
                endLine: 15,
            });

            expect(core.warning).toHaveBeenCalledWith('Deprecated API', {
                endLine: 15,
                file: 'src/classes/Old.cls',
                startLine: 10,
            });
        });

        it('should support annotate with notice level', () => {
            const logger = createGitHubActionsLogger();

            logger.annotate('notice', 'FYI');
            expect(core.notice).toHaveBeenCalledWith('FYI', {});
        });
    });

    describe('child logger buffering', () => {
        it('should return a Logger-conformant child', () => {
            const logger = createGitHubActionsLogger();
            const child = logger.child({package: 'my-pkg'});

            expect(child).toBeDefined();
            expect(child.info).toBeTypeOf('function');
            expect(child.debug).toBeTypeOf('function');
            expect(child.warn).toBeTypeOf('function');
            expect(child.error).toBeTypeOf('function');
            expect(child.trace).toBeTypeOf('function');
        });

        it('should buffer child messages instead of writing immediately', () => {
            const logger = createGitHubActionsLogger();
            const child = logger.child({package: 'my-pkg'});

            child.info('buffered message');
            child.debug('debug message');

            // Nothing written to core.*
            expect(core.info).not.toHaveBeenCalled();
            expect(core.debug).not.toHaveBeenCalled();
        });

        it('should store buffered messages retrievable by key', () => {
            const logger = createGitHubActionsLogger();
            const child = logger.child({package: 'my-pkg'});

            child.info('message 1');
            child.warn('message 2');
            child.error('message 3');
            child.debug('message 4');
            child.trace('message 5');

            const buffer = logger.getChildBuffer('my-pkg');
            expect(buffer).toHaveLength(5);
            expect(buffer[0]).toEqual({level: 'info', message: 'message 1'});
            expect(buffer[1]).toEqual({level: 'warn', message: 'message 2'});
            expect(buffer[2]).toEqual({level: 'error', message: 'message 3'});
            expect(buffer[3]).toEqual({level: 'debug', message: 'message 4'});
            expect(buffer[4]).toEqual({level: 'trace', message: 'message 5'});
        });

        it('should return empty array for unknown child keys', () => {
            const logger = createGitHubActionsLogger();
            expect(logger.getChildBuffer('nonexistent')).toEqual([]);
        });

        it('should support hasChildBuffer', () => {
            const logger = createGitHubActionsLogger();
            expect(logger.hasChildBuffer('pkg')).toBe(false);

            logger.child({package: 'pkg'});
            expect(logger.hasChildBuffer('pkg')).toBe(true);
        });

        it('should support clearChildBuffer', () => {
            const logger = createGitHubActionsLogger();
            const child = logger.child({package: 'pkg'});
            child.info('data');

            logger.clearChildBuffer('pkg');

            expect(logger.hasChildBuffer('pkg')).toBe(false);
            expect(logger.getChildBuffer('pkg')).toEqual([]);
        });

        it('should share buffer when child() is called multiple times with same key', () => {
            const logger = createGitHubActionsLogger();
            const child1 = logger.child({package: 'pkg'});
            const child2 = logger.child({package: 'pkg'});

            child1.info('from child1');
            child2.info('from child2');

            const buffer = logger.getChildBuffer('pkg');
            expect(buffer).toHaveLength(2);
            expect(buffer[0].message).toBe('from child1');
            expect(buffer[1].message).toBe('from child2');
        });

        it('should support nested child() calls sharing same buffer', () => {
            const logger = createGitHubActionsLogger();
            const child = logger.child({package: 'pkg'});
            const nested = child.child!({task: 'deploy'});

            nested.info('nested message');

            const buffer = logger.getChildBuffer('pkg');
            expect(buffer).toHaveLength(1);
            expect(buffer[0].message).toBe('nested message');
        });

        it('top-level methods still write immediately', () => {
            const logger = createGitHubActionsLogger();
            logger.child({package: 'pkg'}); // create a child

            logger.info('top-level');
            expect(core.info).toHaveBeenCalledWith('top-level');
        });
    });
});
