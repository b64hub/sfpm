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
        it('should map log() to core.info()', () => {
            const logger = createGitHubActionsLogger();
            logger.log('test message');
            expect(core.info).toHaveBeenCalledWith('test message');
        });

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
});
