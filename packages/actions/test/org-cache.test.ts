import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {OrgCacheService, type CachedOrgConnection} from '../src/org-cache.js';

// Mock @actions/cache
vi.mock('@actions/cache', () => ({
    ReserveCacheError: class ReserveCacheError extends Error {},
    restoreCache: vi.fn(),
    saveCache: vi.fn(),
}));

// Mock @actions/core
vi.mock('@actions/core', () => ({
    setOutput: vi.fn(),
}));

import * as cache from '@actions/cache';
import * as core from '@actions/core';
import fs from 'node:fs';

describe('OrgCacheService', () => {
    let mockLogger: any;

    beforeEach(() => {
        vi.clearAllMocks();
        mockLogger = {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            log: vi.fn(),
            trace: vi.fn(),
            warn: vi.fn(),
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('restore', () => {
        it('should return undefined when no cache exists', async () => {
            vi.mocked(cache.restoreCache).mockResolvedValue(undefined);

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const result = await service.restore();

            expect(result).toBeUndefined();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('No cached org found'),
            );
        });

        it('should return undefined when cached entry is expired', async () => {
            vi.mocked(cache.restoreCache).mockResolvedValue('sfpm-org-pr-42-123');

            const expiredEntry: CachedOrgConnection = {
                cachedAt: Date.now() - (5 * 60 * 60 * 1000), // 5 hours ago
                cacheTtlMs: 4 * 60 * 60 * 1000, // 4 hour TTL
                orgId: '00D000000000000',
                prNumber: 42,
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            };

            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify(expiredEntry));
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const result = await service.restore();

            expect(result).toBeUndefined();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('expired'),
            );
        });

        it('should return valid cached entry', async () => {
            vi.mocked(cache.restoreCache).mockResolvedValue('sfpm-org-pr-42-123');

            const validEntry: CachedOrgConnection = {
                cachedAt: Date.now() - (30 * 60 * 1000), // 30 minutes ago
                cacheTtlMs: 4 * 60 * 60 * 1000, // 4 hour TTL
                orgId: '00D000000000000',
                prNumber: 42,
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            };

            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify(validEntry));
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const result = await service.restore();

            expect(result).toBeDefined();
            expect(result!.username).toBe('test@scratch.org');
            expect(result!.orgId).toBe('00D000000000000');
        });

        it('should handle cache restore errors gracefully', async () => {
            vi.mocked(cache.restoreCache).mockRejectedValue(new Error('Network error'));

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const result = await service.restore();

            expect(result).toBeUndefined();
            expect(mockLogger.warn).toHaveBeenCalledWith(
                expect.stringContaining('Failed to restore'),
            );
        });
    });

    describe('save', () => {
        it('should write cache entry and save to actions cache', async () => {
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
            vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
            vi.mocked(cache.saveCache).mockResolvedValue(1);

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            await service.save({
                orgId: '00D000000000000',
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            });

            expect(fs.promises.writeFile).toHaveBeenCalled();
            expect(cache.saveCache).toHaveBeenCalled();
            expect(mockLogger.info).toHaveBeenCalledWith(
                expect.stringContaining('Cached org test@scratch.org'),
            );
        });

        it('should handle duplicate cache key gracefully', async () => {
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
            vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
            vi.mocked(cache.saveCache).mockRejectedValue(
                new cache.ReserveCacheError('Cache already exists'),
            );

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            await service.save({
                orgId: '00D000000000000',
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            });

            // Should not throw — just logs debug
            expect(mockLogger.debug).toHaveBeenCalledWith(
                expect.stringContaining('Cache already exists'),
            );
        });
    });

    describe('setOutputs', () => {
        it('should set GitHub Actions outputs', () => {
            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const connection: CachedOrgConnection = {
                cachedAt: Date.now() - (10 * 60 * 1000),
                cacheTtlMs: 4 * 60 * 60 * 1000,
                orgId: '00D000000000000',
                prNumber: 42,
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            };

            service.setOutputs(connection);

            expect(core.setOutput).toHaveBeenCalledWith('org-username', 'test@scratch.org');
            expect(core.setOutput).toHaveBeenCalledWith('org-id', '00D000000000000');
            expect(core.setOutput).toHaveBeenCalledWith('cache-hit', 'true');
        });
    });

    describe('cache TTL configuration', () => {
        it('should use default TTL of 4 hours', async () => {
            vi.mocked(cache.restoreCache).mockResolvedValue('sfpm-org-pr-42-123');

            const justUnder4Hours: CachedOrgConnection = {
                cachedAt: Date.now() - (3.9 * 60 * 60 * 1000), // 3.9 hours ago
                cacheTtlMs: 4 * 60 * 60 * 1000,
                orgId: '00D000000000000',
                prNumber: 42,
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            };

            vi.spyOn(fs, 'existsSync').mockReturnValue(true);
            vi.spyOn(fs.promises, 'readFile').mockResolvedValue(JSON.stringify(justUnder4Hours));
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);

            const service = new OrgCacheService({logger: mockLogger, prNumber: 42});
            const result = await service.restore();

            expect(result).toBeDefined();
        });

        it('should respect custom TTL', async () => {
            vi.spyOn(fs.promises, 'mkdir').mockResolvedValue(undefined);
            vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
            vi.mocked(cache.saveCache).mockResolvedValue(1);

            const service = new OrgCacheService({
                cacheTtlHours: 8,
                logger: mockLogger,
                prNumber: 42,
            });

            await service.save({
                orgId: '00D000000000000',
                sfdxAuthUrl: 'force://...',
                username: 'test@scratch.org',
            });

            // Verify the written file has the correct TTL
            const writeCall = vi.mocked(fs.promises.writeFile).mock.calls[0];
            const written = JSON.parse(writeCall[1] as string) as CachedOrgConnection;
            expect(written.cacheTtlMs).toBe(8 * 60 * 60 * 1000);
        });
    });
});
