import {describe, expect, it, vi} from 'vitest';

import {
    createConsoleLogger,
    isStructuredLogger,
    noopLogger,
    type Logger,
    type StructuredLogger,
} from '../../src/types/logger.js';

describe('Logger', () => {
    describe('noopLogger', () => {
        it('should have all Logger methods', () => {
            expect(noopLogger.log).toBeDefined();
            expect(noopLogger.info).toBeDefined();
            expect(noopLogger.warn).toBeDefined();
            expect(noopLogger.error).toBeDefined();
            expect(noopLogger.debug).toBeDefined();
            expect(noopLogger.trace).toBeDefined();
        });

        it('should not throw when called', () => {
            expect(() => noopLogger.log('test')).not.toThrow();
            expect(() => noopLogger.info('test')).not.toThrow();
            expect(() => noopLogger.warn('test')).not.toThrow();
            expect(() => noopLogger.error('test')).not.toThrow();
            expect(() => noopLogger.debug('test')).not.toThrow();
            expect(() => noopLogger.trace('test')).not.toThrow();
        });
    });

    describe('createConsoleLogger', () => {
        it('should create a logger with default info level', () => {
            const logger = createConsoleLogger();
            const spy = vi.spyOn(console, 'info').mockImplementation(() => {});

            logger.info('test');
            expect(spy).toHaveBeenCalledWith('test');

            spy.mockRestore();
        });

        it('should respect log level — suppress debug at info level', () => {
            const logger = createConsoleLogger({level: 'info'});
            const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

            logger.debug('should be suppressed');
            expect(spy).not.toHaveBeenCalled();

            spy.mockRestore();
        });

        it('should show debug at debug level', () => {
            const logger = createConsoleLogger({level: 'debug'});
            const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});

            logger.debug('visible');
            expect(spy).toHaveBeenCalledWith('visible');

            spy.mockRestore();
        });

        it('should always show errors regardless of level', () => {
            const logger = createConsoleLogger({level: 'error'});
            const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

            logger.error('always visible');
            expect(spy).toHaveBeenCalledWith('always visible');

            spy.mockRestore();
        });

        it('should always show log regardless of level', () => {
            const logger = createConsoleLogger({level: 'error'});
            const spy = vi.spyOn(console, 'log').mockImplementation(() => {});

            logger.log('always visible');
            expect(spy).toHaveBeenCalledWith('always visible');

            spy.mockRestore();
        });
    });

    describe('isStructuredLogger', () => {
        it('should return false for a plain Logger', () => {
            const logger: Logger = {
                debug: vi.fn(),
                error: vi.fn(),
                info: vi.fn(),
                log: vi.fn(),
                trace: vi.fn(),
                warn: vi.fn(),
            };
            expect(isStructuredLogger(logger)).toBe(false);
        });

        it('should return true for a StructuredLogger', () => {
            const logger: StructuredLogger = {
                debug: vi.fn(),
                error: vi.fn(),
                group: vi.fn(),
                groupEnd: vi.fn(),
                info: vi.fn(),
                log: vi.fn(),
                trace: vi.fn(),
                warn: vi.fn(),
            };
            expect(isStructuredLogger(logger)).toBe(true);
        });
    });
});
