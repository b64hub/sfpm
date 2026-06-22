import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('fs-extra', () => {
  const mockFs = {
    pathExists: vi.fn(),
    copy: vi.fn(),
    ensureDir: vi.fn(),
    emptyDir: vi.fn(),
    writeJson: vi.fn(),
    appendFile: vi.fn(),
    remove: vi.fn().mockResolvedValue(undefined),
    move: vi.fn().mockResolvedValue(undefined),
    pathExistsSync: vi.fn(),
  };
  return {
    ...mockFs,
    default: mockFs,
  };
});

vi.mock('@salesforce/source-deploy-retrieve', () => ({
  ComponentSet: {
    fromSource: vi.fn().mockResolvedValue({ size: 0 }),
  },
}));

vi.mock('../../../../src/package/assemblers/steps/mdapi-conversion-step.js', () => {
  return {
    MDAPIConversionStep: class {
      execute = vi.fn().mockResolvedValue(undefined);
    },
  };
});

vi.mock('../../../src/project/project-service.js', () => ({
  default: {
    getInstance: vi.fn().mockResolvedValue({
      resolveForPackage: vi.fn().mockReturnValue({
        packages: [{name: 'my-data', path: 'data', type: 'data', version: '1.0.0'}],
      }),
    }),
  },
}));

// Mock workspace path resolution
vi.mock('../../../src/utils/workspace-path.js', () => ({
  resolvePackageWorkspacePath: vi.fn().mockReturnValue('/root/packages/my-data'),
}));

import fs from 'fs-extra';
import path from 'path';
import PackageAssembler from '../../../../src/package/assemblers/package-assembler.js';

const mockedFs = fs as any;

describe('PackageAssembler — Data packages', () => {
  let mockProvider: any;
  let assembler: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProvider = {
      projectDir: '/root',
      getPackageDefinition: vi.fn().mockReturnValue({
        name: 'my-data',
        path: 'data',
        type: 'data',
        version: '1.0.0',
      }),
      getProjectDefinition: vi.fn().mockReturnValue({
        packages: [{name: 'my-data', path: 'data', type: 'data', version: '1.0.0'}],
      }),
      resolveForPackage: vi.fn().mockReturnValue({
        packages: [{name: 'my-data', path: 'data', type: 'data', version: '1.0.0'}],
      }),
    };

    assembler = new PackageAssembler('my-data', mockProvider as any);
  });

  it('should use reduced assembly pipeline for data packages', async () => {
    mockedFs.pathExists.mockResolvedValue(true);
    mockedFs.copy.mockResolvedValue(undefined);
    mockedFs.ensureDir.mockResolvedValue(undefined);
    mockedFs.emptyDir.mockResolvedValue(undefined);
    mockedFs.writeJson.mockResolvedValue(undefined);
    mockedFs.appendFile.mockResolvedValue(undefined);

    const result = await assembler.assemble();
    const stagingPath = result.stagingDirectory;

    expect(stagingPath).toBe(path.join('/root/packages/my-data', 'dist'));

    // Should copy source (to temp dir, then moved into dist/force-app)
    expect(mockedFs.copy).toHaveBeenCalledWith(
      path.join('/root', 'data'),
      expect.stringContaining('sfpm-stage-'),
      expect.objectContaining({ filter: expect.any(Function) }),
    );

    // Should write sfdx-project.json
    expect(mockedFs.writeJson).toHaveBeenCalledWith(
      path.join(stagingPath, 'sfdx-project.json'),
      expect.any(Object),
      {spaces: 4},
    );
  });

  it('should NOT copy org definitions for data packages', async () => {
    mockedFs.pathExists.mockResolvedValue(true);
    mockedFs.copy.mockResolvedValue(undefined);
    mockedFs.ensureDir.mockResolvedValue(undefined);
    mockedFs.emptyDir.mockResolvedValue(undefined);
    mockedFs.writeJson.mockResolvedValue(undefined);
    mockedFs.appendFile.mockResolvedValue(undefined);

    await assembler.withOrgDefinition('config/project-scratch-def.json').assemble();

    // Verify org definition was NOT copied (data packages skip OrgDefinitionStep)
    const copyCalls = mockedFs.copy.mock.calls;
    const orgDefCopy = copyCalls.find((call: any[]) =>
      call[0].includes('project-scratch-def'),
    );
    expect(orgDefCopy).toBeUndefined();
  });
});
