import { vi, expect, describe, it, beforeEach } from 'vitest';
import path from 'path';

vi.mock('fs-extra', () => {
    const mockFs = {
        pathExists: vi.fn(),
        copy: vi.fn(),
        ensureDir: vi.fn(),
        emptyDir: vi.fn(),
        writeJSON: vi.fn(),
        appendFile: vi.fn(),
        remove: vi.fn().mockResolvedValue(undefined),
        pathExistsSync: vi.fn(),
    };
    return {
        ...mockFs,
        default: mockFs
    };
});

vi.mock('../../../src/package/assemblers/steps/mdapi-conversion-step.js', () => {
    return {
        MDAPIConversionStep: class {
            execute = vi.fn().mockResolvedValue(undefined);
        }
    };
});

import fs from 'fs-extra';
import PackageAssembler from '../../../src/package/assemblers/package-assembler.js';
import ProjectConfig from '../../../src/project/project-config.js';

const mockedFs = fs as any;

describe('PackageAssembler', () => {
    let mockProjectConfig: any;
    let assembler: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockProjectConfig = {
            projectDirectory: '/root',
            getPackageDefinition: vi.fn().mockReturnValue({
                path: 'force-app',
                package: 'core',
                versionNumber: '1.0.0.0'
            }),
            getProjectDefinition: vi.fn().mockReturnValue({
                packageDirectories: [{ path: 'force-app', package: 'core', versionNumber: '1.0.0.0' }]
            }),
            getPrunedDefinition: vi.fn().mockReturnValue({
                packageDirectories: [{ path: 'force-app', package: 'core', versionNumber: '1.0.0.0' }]
            })
        };

        assembler = new PackageAssembler('core', mockProjectConfig as any);
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
        expect((assembler as any).options.versionNumber).toBe('1.2.0-5');
        expect((assembler as any).options.orgDefinitionPath).toBe('config/project-scratch-def.json');
        expect((assembler as any).options.destructiveManifestPath).toBe('destructive/changes.xml');
        expect((assembler as any).options.replacementForceignorePath).toBe('.forceignore.prod');
    });

    it('should assemble package correctly', async () => {
        // Mock fs calls
        mockedFs.pathExists.mockResolvedValue(true);
        mockedFs.copy.mockResolvedValue(undefined);
        mockedFs.ensureDir.mockResolvedValue(undefined);
        mockedFs.emptyDir.mockResolvedValue(undefined);
        mockedFs.writeJSON.mockResolvedValue(undefined);
        mockedFs.appendFile.mockResolvedValue(undefined);

        const result = await assembler.assemble();
        const stagingPath = result.stagingDirectory;

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
        const assembler2 = new PackageAssembler('core', mockProjectConfig as any);
        expect((assembler as any).stagingDirectory).not.toBe((assembler2 as any).stagingDirectory);
    });
});
