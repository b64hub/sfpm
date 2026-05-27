import {describe, it, expect, vi, beforeEach} from 'vitest';
import EventEmitter from 'node:events';

import ValidationTask from '../../../../src/package/builders/tasks/validation-task.js';
import {BuildError} from '../../../../src/types/errors.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

// Import after mock to get the mocked version
import {Org} from '@salesforce/core';

describe('ValidationTask', () => {
  let mockSfpmPackage: any;
  let mockLogger: any;
  let mockEventEmitter: EventEmitter;
  let mockConnection: any;
  let mockDeploy: any;

  const packageName = 'my-package';
  const buildOrg = 'test@org.com';

  beforeEach(() => {
    vi.resetAllMocks();

    mockSfpmPackage = {
      packageName,
      hasApex: true,
      testClasses: ['MyTest', 'OtherTest'],
      testCoverage: undefined as number | undefined,
      getComponentSet: vi.fn(),
    };

    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    mockEventEmitter = new EventEmitter();

    mockConnection = {
      metadata: {
        checkDeployStatus: vi.fn(),
      },
    };

    mockDeploy = {
      id: 'deploy-123',
    };

    vi.mocked(Org.create).mockResolvedValue({
      getConnection: () => mockConnection,
    } as any);
  });

  function createTask(): ValidationTask {
    return new ValidationTask(mockSfpmPackage, buildOrg, mockLogger, mockEventEmitter);
  }

  function setupSuccessfulDeploy(options?: {
    numTestsRun?: number;
    numFailures?: number;
    codeCoverage?: any[];
    failures?: any[];
  }) {
    const numTestsRun = options?.numTestsRun ?? 2;
    const numFailures = options?.numFailures ?? 0;
    const codeCoverage = options?.codeCoverage ?? [
      {numLocations: 100, numLocationsNotCovered: 20},
    ];

    const mockComponentSet = {
      size: 10,
      deploy: vi.fn().mockResolvedValue(mockDeploy),
    };
    mockSfpmPackage.getComponentSet.mockReturnValue(mockComponentSet);

    mockConnection.metadata.checkDeployStatus.mockResolvedValue({
      done: true,
      success: true,
      details: {
        runTestResult: {
          numTestsRun: String(numTestsRun),
          numFailures: String(numFailures),
          failures: options?.failures,
          codeCoverage,
        },
      },
    });

    return mockComponentSet;
  }

  it('should skip when package has no Apex', async () => {
    mockSfpmPackage.hasApex = false;
    const task = createTask();
    await task.exec();
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('no Apex'));
  });

  it('should throw BuildError when package has Apex but no test classes', async () => {
    mockSfpmPackage.testClasses = [];
    const task = createTask();
    await expect(task.exec()).rejects.toThrow(BuildError);
    await expect(task.exec()).rejects.toThrow('no test classes defined');
  });

  it('should deploy with RunSpecifiedTests and the package test classes', async () => {
    const mockComponentSet = setupSuccessfulDeploy();
    const task = createTask();
    await task.exec();

    expect(mockComponentSet.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        usernameOrConnection: mockConnection,
        apiOptions: expect.objectContaining({
          testLevel: 'RunSpecifiedTests',
          runTests: ['MyTest', 'OtherTest'],
        }),
      }),
    );
  });

  it('should resolve test class names from objects with name property', async () => {
    mockSfpmPackage.testClasses = [{name: 'TestA'}, {name: 'TestB'}];
    const mockComponentSet = setupSuccessfulDeploy();
    const task = createTask();
    await task.exec();

    expect(mockComponentSet.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiOptions: expect.objectContaining({
          runTests: ['TestA', 'TestB'],
        }),
      }),
    );
  });

  it('should throw BuildError when deployment fails', async () => {
    const mockComponentSet = {
      size: 10,
      deploy: vi.fn().mockResolvedValue(mockDeploy),
    };
    mockSfpmPackage.getComponentSet.mockReturnValue(mockComponentSet);

    mockConnection.metadata.checkDeployStatus.mockResolvedValue({
      done: true,
      success: false,
      details: {
        componentFailures: [{fullName: 'MyClass', problem: 'compile error'}],
      },
    });

    const task = createTask();
    await expect(task.exec()).rejects.toThrow(BuildError);
    await expect(task.exec()).rejects.toThrow('deployment failed');
  });

  it('should throw BuildError when tests fail', async () => {
    setupSuccessfulDeploy({
      numTestsRun: 2,
      numFailures: 1,
      failures: [{name: 'MyTest', methodName: 'testMethod', message: 'assertion failed'}],
    });

    const task = createTask();
    await expect(task.exec()).rejects.toThrow(BuildError);
    await expect(task.exec()).rejects.toThrow('Apex test(s) failed');
  });

  it('should throw BuildError when coverage is below threshold', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 100, numLocationsNotCovered: 50}],
    });

    const task = createTask();
    await expect(task.exec()).rejects.toThrow(BuildError);
    await expect(task.exec()).rejects.toThrow('below the required 75%');
  });

  it('should pass when coverage meets threshold', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 100, numLocationsNotCovered: 20}],
    });

    const task = createTask();
    await task.exec();
    expect(mockSfpmPackage.testCoverage).toBe(80);
  });

  it('should calculate coverage across multiple coverage entries', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [
        {numLocations: 100, numLocationsNotCovered: 10},
        {numLocations: 50, numLocationsNotCovered: 5},
      ],
    });

    const task = createTask();
    await task.exec();
    // 90 + 45 = 135 covered / 150 total = 90%
    expect(mockSfpmPackage.testCoverage).toBe(90);
  });

  it('should emit source:test:start and source:test:complete events', async () => {
    setupSuccessfulDeploy();

    const startEvents: any[] = [];
    const completeEvents: any[] = [];
    mockEventEmitter.on('source:test:start', (evt) => startEvents.push(evt));
    mockEventEmitter.on('source:test:complete', (evt) => completeEvents.push(evt));

    const task = createTask();
    await task.exec();

    expect(startEvents).toHaveLength(1);
    expect(startEvents[0]).toMatchObject({
      packageName,
      testCount: 2,
      testLevel: 'RunSpecifiedTests',
    });

    expect(completeEvents).toHaveLength(1);
    expect(completeEvents[0]).toMatchObject({
      packageName,
      testCount: 2,
      passed: 2,
      failed: 0,
      coveragePercentage: 80,
      coverageRequired: 75,
    });
  });

  it('should set testCoverage on the package', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 100, numLocationsNotCovered: 25}],
    });

    const task = createTask();
    await task.exec();
    expect(mockSfpmPackage.testCoverage).toBe(75);
  });

  it('should handle zero coverage lines gracefully', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 0, numLocationsNotCovered: 0}],
    });

    const task = createTask();
    // 0% coverage should fail threshold check
    await expect(task.exec()).rejects.toThrow('below the required 75%');
  });

  it('should connect to the correct org', async () => {
    setupSuccessfulDeploy();

    const task = createTask();
    await task.exec();

    expect(Org.create).toHaveBeenCalledWith({aliasOrUsername: buildOrg});
  });

  // ==========================================================================
  // Test-only mode
  // ==========================================================================

  describe('test-only mode', () => {
    function createTestOnlyTask(): ValidationTask {
      return new ValidationTask(mockSfpmPackage, buildOrg, mockLogger, mockEventEmitter, {testOnly: true});
    }

    function setupToolingMock(options?: {
      methodsCompleted?: number;
      methodsFailed?: number;
      status?: string;
      failureRecords?: any[];
    }) {
      const methodsCompleted = options?.methodsCompleted ?? 2;
      const methodsFailed = options?.methodsFailed ?? 0;
      const status = options?.status ?? 'Completed';

      mockConnection.tooling = {
        runTestsAsynchronous: vi.fn().mockResolvedValue('test-run-123'),
        query: vi.fn().mockImplementation((query: string) => {
          if (query.includes('ApexTestRunResult')) {
            return Promise.resolve({
              records: [{
                Status: status,
                MethodsCompleted: methodsCompleted,
                MethodsFailed: methodsFailed,
                MethodsEnqueued: 0,
              }],
            });
          }

          // ApexTestResult query for failures
          return Promise.resolve({
            records: options?.failureRecords ?? [],
          });
        }),
      };
    }

    it('should run tests via tooling API without deploying', async () => {
      setupToolingMock();
      const task = createTestOnlyTask();
      await task.exec();

      expect(mockConnection.tooling.runTestsAsynchronous).toHaveBeenCalledWith({
        classNames: 'MyTest,OtherTest',
      });
      // Should NOT call getComponentSet (no deploy)
      expect(mockSfpmPackage.getComponentSet).not.toHaveBeenCalled();
    });

    it('should pass when all tests succeed', async () => {
      setupToolingMock({methodsCompleted: 5, methodsFailed: 0});
      const task = createTestOnlyTask();
      await expect(task.exec()).resolves.toBeUndefined();
    });

    it('should throw BuildError when tests fail', async () => {
      setupToolingMock({
        methodsCompleted: 3,
        methodsFailed: 1,
        failureRecords: [{
          ApexClass: {Name: 'MyTest'},
          MethodName: 'testMethod',
          Message: 'assertion failed',
        }],
      });

      const task = createTestOnlyTask();
      await expect(task.exec()).rejects.toThrow(BuildError);
      await expect(task.exec()).rejects.toThrow('Apex test(s) failed');
    });

    it('should not check coverage in test-only mode', async () => {
      setupToolingMock({methodsCompleted: 2, methodsFailed: 0});
      const task = createTestOnlyTask();
      // Even though no coverage data is available, it should not fail
      await expect(task.exec()).resolves.toBeUndefined();
      // testCoverage should not be set
      expect(mockSfpmPackage.testCoverage).toBeUndefined();
    });

    it('should emit events with RunSpecifiedTests test level', async () => {
      setupToolingMock();

      const startEvents: any[] = [];
      mockEventEmitter.on('source:test:start', (evt) => startEvents.push(evt));

      const task = createTestOnlyTask();
      await task.exec();

      expect(startEvents[0]).toMatchObject({
        testLevel: 'RunSpecifiedTests',
      });
    });

    it('should skip when package has no Apex', async () => {
      mockSfpmPackage.hasApex = false;
      const task = createTestOnlyTask();
      await task.exec();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('no Apex'));
    });
  });

  // ==========================================================================
  // Async API (startAsync / awaitResult)
  // ==========================================================================

  describe('startAsync / awaitResult', () => {
    it('should return null for packages with no Apex', async () => {
      mockSfpmPackage.hasApex = false;
      const task = createTask();
      const handle = await task.startAsync();
      expect(handle).toBeNull();
    });

    it('should return a handle with deploy ID for deploy mode', async () => {
      setupSuccessfulDeploy();
      const task = createTask();
      const handle = await task.startAsync();

      expect(handle).toMatchObject({
        jobId: 'deploy-123',
        mode: 'deploy',
        packageName,
        testClassNames: ['MyTest', 'OtherTest'],
      });
    });

    it('should return a handle with test run ID for test-only mode', async () => {
      mockConnection.tooling = {
        runTestsAsynchronous: vi.fn().mockResolvedValue('test-run-456'),
        query: vi.fn(),
      };

      const task = new ValidationTask(mockSfpmPackage, buildOrg, mockLogger, mockEventEmitter, {testOnly: true});
      const handle = await task.startAsync();

      expect(handle).toMatchObject({
        jobId: 'test-run-456',
        mode: 'test-only',
        packageName,
      });
    });

    it('should resolve successfully when awaitResult processes a passing deploy', async () => {
      setupSuccessfulDeploy();
      const task = createTask();
      const handle = await task.startAsync();
      expect(handle).not.toBeNull();
      await expect(task.awaitResult(handle!)).resolves.toBeUndefined();
    });

    it('should throw when awaitResult processes a failing test-only run', async () => {
      mockConnection.tooling = {
        runTestsAsynchronous: vi.fn().mockResolvedValue('test-run-789'),
        query: vi.fn().mockImplementation((query: string) => {
          if (query.includes('ApexTestRunResult')) {
            return Promise.resolve({
              records: [{Status: 'Completed', MethodsCompleted: 3, MethodsFailed: 1, MethodsEnqueued: 0}],
            });
          }
          return Promise.resolve({
            records: [{ApexClass: {Name: 'MyTest'}, MethodName: 'testFoo', Message: 'expected true'}],
          });
        }),
      };

      const task = new ValidationTask(mockSfpmPackage, buildOrg, mockLogger, mockEventEmitter, {testOnly: true});
      const handle = await task.startAsync();
      await expect(task.awaitResult(handle!)).rejects.toThrow('Apex test(s) failed');
    });
  });
});
