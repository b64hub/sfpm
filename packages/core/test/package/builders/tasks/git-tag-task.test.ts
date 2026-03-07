import { describe, it, expect, vi, beforeEach } from 'vitest';
import GitTagTask from '../../../../src/package/builders/tasks/git-tag-task.js';
import Git from '../../../../src/git/git.js';
import { toVersionFormat } from '../../../../src/utils/version-utils.js';

vi.mock('../../../../src/git/git.js');
vi.mock('../../../../src/utils/version-utils.js');

describe('GitTagTask', () => {
    let mockSfpmPackage: any;
    let mockLogger: any;
    let mockGitInstance: any;
    let task: GitTagTask;

    const packageName = 'my-package';
    const version = '1.0.0.1';
    const normalizedVersion = '1.0.0-1';
    const expectedTag = `${packageName}@${normalizedVersion}`;

    beforeEach(() => {
        vi.resetAllMocks();

        mockSfpmPackage = {
            packageName,
            version,
            metadata: {
                identity: { packageName, versionNumber: version },
                source: {},
                orchestration: {}
            }
        };

        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            warn: vi.fn()
        };

        vi.mocked(toVersionFormat).mockReturnValue(normalizedVersion);

        // Mock Git.initiateRepo static method
        mockGitInstance = {
            addAnnotatedTag: vi.fn().mockResolvedValue(undefined)
        };
        vi.mocked(Git.initiateRepo).mockResolvedValue(mockGitInstance);

        task = new GitTagTask(mockSfpmPackage, '/artifact/dir', mockLogger);
    });

    it('should create a tag with the correct convention', async () => {
        await task.exec();

        expect(toVersionFormat).toHaveBeenCalledWith(version, 'semver');
        expect(Git.initiateRepo).toHaveBeenCalledWith(mockLogger);

        expect(mockGitInstance.addAnnotatedTag).toHaveBeenCalledWith(
            expectedTag,
            expect.stringContaining(`sfpm package ${normalizedVersion}`)
        );

        expect(mockSfpmPackage.metadata.source.tag).toBe(expectedTag);
        expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining(`Successfully tagged`));
    });

    it('should use default version if package version is missing', async () => {
        mockSfpmPackage.version = undefined;
        await task.exec();

        expect(toVersionFormat).toHaveBeenCalledWith('0.0.0.1', 'semver');
    });
});
