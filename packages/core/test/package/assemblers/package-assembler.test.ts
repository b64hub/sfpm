import { jest, expect, describe, it, beforeEach } from '@jest/globals';
import path from 'path';

// Use unstable_mockModule for ESM mocking
jest.unstable_mockModule('fs-extra', () => ({
    __esModule: true,
    pathExists: jest.fn(),
    copy: jest.fn(),
    ensureDir: jest.fn(),
    emptyDir: jest.fn(),
    writeJSON: jest.fn(),
    appendFile: jest.fn(),
    remove: jest.fn(),
    pathExistsSync: jest.fn(),
}));

// Dynamically import dependencies that use the mock
const fs = await import('fs-extra');
const { default: PackageAssembler } = await import('../../../src/package/assemblers/package-assembler.js');
const { default: ProjectConfig } = await import('../../../src/project/project-config.js');

const mockedFs = fs as any;

describe('PackageAssembler', () => {
    let mockProjectConfig: any;
    let assembler: any;

    beforeEach(() => {
        jest.clearAllMocks();

        mockProjectConfig = {
            projectDirectory: '/root',
            getPackageDefinition: jest.fn().mockReturnValue({
                path: 'force-app',
                package: 'core',
                versionNumber: '1.0.0.0'
            }),
            getProjectDefinition: jest.fn().mockReturnValue({
                packageDirectories: [{ path: 'force-app', package: 'core', versionNumber: '1.0.0.0' }]
            }),
            getPrunedDefinition: jest.fn().mockReturnValue({
                packageDirectories: [{ path: 'force-app', package: 'core', versionNumber: '1.0.0.0' }]
            })
        };

        assembler = new PackageAssembler(mockProjectConfig as any, 'core');
    });

    it('should initialize staging directory in constructor', () => {
        expect((assembler as any).stagingDirectory).toContain('.sfpm/tmp/builds');
        expect((assembler as any).stagingDirectory).toContain('core');
    });

    it('should allow fluent configuration', () => {
        const result = assembler
            .withVersion('1.2.0-5')
            .withOrgDefinition('config/project-scratch-def.json')
            .withDestructiveManifest('destructive/changes.xml')
            .withReplacementForceIgnore('.forceignore.prod');

        expect(result).toBe(assembler);
        expect((assembler as any).versionNumber).toBe('1.2.0-5');
        expect((assembler as any).orgDefinitionFilePath).toBe('config/project-scratch-def.json');
        expect((assembler as any).destructiveManifestFilePath).toBe('destructive/changes.xml');
        expect((assembler as any).pathToReplacementForceIgnore).toBe('.forceignore.prod');
    });

    it('should assemble package correctly', async () => {
        // Mock fs calls
        mockedFs.pathExists.mockResolvedValue(true);
        mockedFs.copy.mockResolvedValue(undefined);
        mockedFs.ensureDir.mockResolvedValue(undefined);
        mockedFs.emptyDir.mockResolvedValue(undefined);
        mockedFs.writeJSON.mockResolvedValue(undefined);
        mockedFs.appendFile.mockResolvedValue(undefined);

        const stagingPath = await assembler.assemble();

        expect(stagingPath).toContain('.sfpm/tmp/builds');

        // Verify core orchestration steps
        expect(mockedFs.emptyDir).toHaveBeenCalledWith(stagingPath);
        // Copy source
        expect(mockedFs.copy).toHaveBeenCalledWith(
            path.join('/root', 'force-app'),
            path.join(stagingPath, 'force-app')
        );
        // Write manifest
        expect(mockedFs.writeJSON).toHaveBeenCalledWith(
            path.join(stagingPath, 'sfdx-project.json'),
            expect.any(Object),
            { spaces: 4 }
        );
    });

    it('should cleanup on failure', async () => {
        mockedFs.ensureDir.mockRejectedValue(new Error('Failed to create dir'));
        mockedFs.remove.mockResolvedValue(undefined);

        await expect(assembler.assemble()).rejects.toThrow('Failed to create dir');

        expect(mockedFs.remove).toHaveBeenCalled();
    });

    it('should not cleanup on failure if DEBUG is true', async () => {
        process.env.DEBUG = 'true';
        mockedFs.ensureDir.mockRejectedValue(new Error('Failed to create dir'));

        await expect(assembler.assemble()).rejects.toThrow('Failed to create dir');

        expect(mockedFs.remove).not.toHaveBeenCalled();
        delete process.env.DEBUG;
    });

    it('should create unique build names', () => {
        const assembler2 = new PackageAssembler(mockProjectConfig as any, 'core');
        expect((assembler as any).stagingDirectory).not.toBe((assembler2 as any).stagingDirectory);
    });
});
