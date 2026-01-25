import { vi, expect, describe, it, beforeEach } from 'vitest';
import path from 'path';

// Mock fs-extra
vi.mock('fs-extra', () => {
    const mockFs = {
        pathExists: vi.fn(),
        copy: vi.fn(),
        ensureDir: vi.fn(),
        writeJSON: vi.fn(),
    };
    return {
        ...mockFs,
        default: mockFs
    };
});

import fs from 'fs-extra';
import { ProjectJsonAssemblyStep } from '../../../../src/package/assemblers/steps/project-json-assembly-step.js';

describe('ProjectJsonAssemblyStep', () => {
    let mockProjectConfig: any;
    let step: ProjectJsonAssemblyStep;
    let options: any;
    let output: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockProjectConfig = {
            projectDirectory: '/root',
            getPrunedDefinition: vi.fn().mockReturnValue({
                packageDirectories: [{
                    path: 'force-app',
                    package: 'core',
                    versionNumber: '1.0.0.NEXT'
                }]
            })
        };

        step = new ProjectJsonAssemblyStep('core', mockProjectConfig as any);
        options = { versionNumber: '1.2.3.4' };
        output = {
            stagingDirectory: '/staging',
            projectDefinitionPath: ''
        };
    });

    it('should inject version number and use absolute path for unpackagedMetadata', async () => {
        (fs.pathExists as any).mockImplementation((p: string) => {
            if (p === path.join('/staging', 'unpackagedMetadata')) return Promise.resolve(true);
            return Promise.resolve(false);
        });
        (fs.writeJSON as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        expect(fs.writeJSON).toHaveBeenCalledWith(
            path.join('/staging', 'sfdx-project.json'),
            expect.objectContaining({
                packageDirectories: [
                    expect.objectContaining({
                        package: 'core',
                        versionNumber: '1.2.3.4',
                        unpackagedMetadata: {
                            path: path.join('/staging', 'unpackagedMetadata')
                        }
                    })
                ]
            }),
            { spaces: 4 }
        );

        // Verify it didn't push extra package directories
        const writtenManifest = (fs.writeJSON as any).mock.calls[0][1];
        expect(writtenManifest.packageDirectories).toHaveLength(1);
    });

    it('should not add unpackagedMetadata if directory does not exist', async () => {
        (fs.pathExists as any).mockResolvedValue(false);
        (fs.writeJSON as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        const writtenManifest = (fs.writeJSON as any).mock.calls[0][1];
        expect(writtenManifest.packageDirectories[0].unpackagedMetadata).toBeUndefined();
    });

    it('should inject script paths if they exist', async () => {
        (fs.pathExists as any).mockImplementation((p: string) => {
            if (p === path.join('/staging', 'scripts', 'preDeployment')) return Promise.resolve(true);
            if (p === path.join('/staging', 'scripts', 'postDeployment')) return Promise.resolve(true);
            return Promise.resolve(false);
        });
        (fs.writeJSON as any).mockResolvedValue(undefined);
        (fs.ensureDir as any).mockResolvedValue(undefined);
        (fs.copy as any).mockResolvedValue(undefined);

        await step.execute(options, output);

        expect(fs.writeJSON).toHaveBeenCalledWith(
            path.join('/staging', 'sfdx-project.json'),
            expect.objectContaining({
                packageDirectories: [
                    expect.objectContaining({
                        packageOptions: expect.objectContaining({
                            deploy: expect.objectContaining({
                                pre: { script: path.join('scripts', 'preDeployment') },
                                post: { script: path.join('scripts', 'postDeployment') }
                            })
                        })
                    })
                ]
            }),
            { spaces: 4 }
        );
    });
});
