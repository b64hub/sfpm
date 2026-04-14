import { vi, expect, describe, it, beforeEach } from 'vitest';
import path from 'path';

// Mock fs-extra
vi.mock('fs-extra', () => {
    const mockFs = {
        pathExists: vi.fn(),
        copy: vi.fn(),
        ensureDir: vi.fn(),
        writeJson: vi.fn(),
    };
    return {
        ...mockFs,
        default: mockFs
    };
});

vi.mock('@salesforce/source-deploy-retrieve', () => ({
    ComponentSet: {
        fromSource: vi.fn().mockResolvedValue({ size: 0 }),
    },
}));

const { mockResolveForPackage } = vi.hoisted(() => ({
    mockResolveForPackage: vi.fn(),
}));
vi.mock('../../../../src/project/project-service.js', () => ({
    default: {
        getInstance: vi.fn().mockResolvedValue({
            resolveForPackage: mockResolveForPackage,
        }),
    },
}));

import fs from 'fs-extra';
import { ProjectJsonAssemblyStep } from '../../../../src/package/assemblers/steps/project-json-assembly-step.js';

describe('ProjectJsonAssemblyStep', () => {
    let mockProvider: any;
    let step: ProjectJsonAssemblyStep;
    let options: any;
    let output: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockProvider = {
            projectDir: '/root',
            resolveForPackage: vi.fn().mockReturnValue({
                packageDirectories: [{
                    path: 'force-app',
                    package: 'core',
                    versionNumber: '1.0.0.NEXT'
                }]
            }),
        };

        step = new ProjectJsonAssemblyStep('core', mockProvider as any);
        options = { versionNumber: '1.2.3.4' };
        output = {
            stagingDirectory: '/staging',
            projectDefinitionPath: ''
        };
    });

    it('should inject version number and use relative path for unpackagedMetadata', async () => {
        (fs.pathExists as any).mockImplementation((p: string) => {
            if (p === path.join('/staging', 'unpackagedMetadata')) return Promise.resolve(true);
            return Promise.resolve(false);
        });
        (fs.writeJson as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        expect(fs.writeJson).toHaveBeenCalledWith(
            path.join('/staging', 'sfdx-project.json'),
            expect.objectContaining({
                packageDirectories: [
                    expect.objectContaining({
                        package: 'core',
                        versionNumber: '1.2.3.4',
                        unpackagedMetadata: {
                            path: 'unpackagedMetadata'
                        }
                    })
                ]
            }),
            { spaces: 4 }
        );

        // Verify it didn't push extra package directories
        const writtenManifest = (fs.writeJson as any).mock.calls[0][1];
        expect(writtenManifest.packageDirectories).toHaveLength(1);
    });

    it('should not add unpackagedMetadata if directory does not exist', async () => {
        (fs.pathExists as any).mockResolvedValue(false);
        (fs.writeJson as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        const writtenManifest = (fs.writeJson as any).mock.calls[0][1];
        expect(writtenManifest.packageDirectories[0].unpackagedMetadata).toBeUndefined();
    });

    it('should not inject script paths into deploy options', async () => {
        (fs.pathExists as any).mockImplementation((p: string) => {
            if (p === path.join('/staging', 'scripts', 'pre', 'setup.sh')) return Promise.resolve(true);
            return Promise.resolve(false);
        });
        (fs.writeJson as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        const writtenManifest = (fs.writeJson as any).mock.calls[0][1];
        const pkg = writtenManifest.packageDirectories[0];
        expect(pkg.packageOptions?.deploy?.pre?.script).toBeUndefined();
        expect(pkg.packageOptions?.deploy?.post?.script).toBeUndefined();
    });
});
