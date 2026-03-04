import {beforeEach, describe, expect, it, vi} from 'vitest';

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
    default: mockFs,
  };
});

vi.mock('../../../../src/package/assemblers/steps/mdapi-conversion-step.js', () => {
  return {
    MDAPIConversionStep: class {
      execute = vi.fn().mockResolvedValue(undefined);
    },
  };
});

import fs from 'fs-extra';
import path from 'path';
import PackageAssembler from '../../../../src/package/assemblers/package-assembler.js';

const mockedFs = fs as any;

describe('PackageAssembler — Data packages', () => {
  let mockProjectConfig: any;
  let assembler: any;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectConfig = {
      projectDirectory: '/root',
      getPackageDefinition: vi.fn().mockReturnValue({
        package: 'my-data',
        path: 'data',
        type: 'data',
        versionNumber: '1.0.0.0',
      }),
      getProjectDefinition: vi.fn().mockReturnValue({
        packageDirectories: [{package: 'my-data', path: 'data', type: 'data', versionNumber: '1.0.0.0'}],
      }),
      getPrunedDefinition: vi.fn().mockReturnValue({
        packageDirectories: [{package: 'my-data', path: 'data', type: 'data', versionNumber: '1.0.0.0'}],
      }),
    };

    assembler = new PackageAssembler('my-data', mockProjectConfig as any);
  });

  it('should use reduced assembly pipeline for data packages', async () => {
    mockedFs.pathExists.mockResolvedValue(true);
    mockedFs.copy.mockResolvedValue(undefined);
    mockedFs.ensureDir.mockResolvedValue(undefined);
    mockedFs.emptyDir.mockResolvedValue(undefined);
    mockedFs.writeJSON.mockResolvedValue(undefined);
    mockedFs.appendFile.mockResolvedValue(undefined);

    const result = await assembler.assemble();
    const stagingPath = result.stagingDirectory;

    expect(stagingPath).toContain('.sfpm/tmp/builds');

    // Should copy source (data directory)
    expect(mockedFs.copy).toHaveBeenCalledWith(
      path.join('/root', 'data'),
      path.join(stagingPath, 'data'),
    );

    // Should write sfdx-project.json
    expect(mockedFs.writeJSON).toHaveBeenCalledWith(
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
    mockedFs.writeJSON.mockResolvedValue(undefined);
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
