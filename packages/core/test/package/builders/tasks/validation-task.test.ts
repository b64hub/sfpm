import {describe, it, expect, vi, beforeEach} from 'vitest';

import {BuildEventBus} from '../../../../src/events/build-event-bus.js';
import ValidationTask from '../../../../src/package/builders/tasks/validation-task.js';
import {SfpmMetadataPackage} from '../../../../src/package/sfpm-package.js';
import {BuildError} from '../../../../src/types/errors.js';

// Mock @salesforce/core
vi.mock('@salesforce/core', () => ({
  Org: {
    create: vi.fn(),
  },
}));

// Mock @salesforce/apex-node
const mockTestService = {
  buildAsyncPayload: vi.fn(),
  reportAsyncResults: vi.fn(),
  runTestAsynchronous: vi.fn(),
};

vi.mock('@salesforce/apex-node', () => ({
  TestService: vi.fn().mockImplementation(function() { return mockTestService; }),
  TestLevel: {RunSpecifiedTests: 'RunSpecifiedTests'},
}));

// Import after mock to get the mocked version
import {Org} from '@salesforce/core';

describe('ValidationTask', () => {
  let mockSfpmPackage: any;
  let mockLogger: any;
  let buildBus: BuildEventBus;
  let mockConnection: any;
  let mockDeploy: any;

  const packageName = 'my-package';
  const buildOrg = 'test@org.com';

  beforeEach(() => {
    vi.clearAllMocks();

    mockSfpmPackage = Object.create(SfpmMetadataPackage.prototype);
    Object.defineProperties(mockSfpmPackage, {
      packageName: {value: packageName, writable: true, configurable: true},
      hasApex: {value: true, writable: true, configurable: true},
      testClasses: {value: ['MyTest', 'OtherTest'], writable: true, configurable: true},
      testCoverage: {value: undefined as number | undefined, writable: true, configurable: true},
    });
    mockSfpmPackage.getComponentSet = vi.fn();
    mockSfpmPackage.classifyApex = vi.fn().mockResolvedValue(undefined);
    mockSfpmPackage.ensureAnalyzed = vi.fn().mockResolvedValue(undefined);

    mockLogger = {
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };

    buildBus = new BuildEventBus();

    mockConnection = {};

    mockDeploy = {
      id: 'deploy-123',
      onUpdate: vi.fn(),
      pollStatus: vi.fn(),
    };

    vi.mocked(Org.create).mockResolvedValue({
      getConnection: () => mockConnection,
    } as any);
  });

  function createTask(): ValidationTask {
    return new ValidationTask(
      {sfpmPackage: mockSfpmPackage, projectDirectory: '/tmp/test', logger: mockLogger, sink: buildBus.forPackage(packageName)},
      {validationOrg: buildOrg},
    );
  }

  function setupSuccessfulDeploy(options?: {
    numTestsRun?: number;
    numFailures?: number;
    codeCoverage?: any[];
    failures?: any[];
    successes?: any[];
  }) {
    const numTestsRun = options?.numTestsRun ?? 2;
    const numFailures = options?.numFailures ?? 0;
    const codeCoverage = options?.codeCoverage ?? [
      {numLocations: 100, numLocationsNotCovered: 20, name: 'MyClass'},
    ];

    const mockComponentSet = {
      size: 10,
      deploy: vi.fn().mockResolvedValue(mockDeploy),
    };
    mockSfpmPackage.getComponentSet.mockReturnValue(mockComponentSet);

    mockDeploy.pollStatus.mockResolvedValue({
      response: {
        done: true,
        success: true,
        numberComponentsDeployed: 10,
        numberComponentsTotal: 10,
        details: {
          runTestResult: {
            numTestsRun: String(numTestsRun),
            numFailures: String(numFailures),
            failures: options?.failures,
            successes: options?.successes,
            codeCoverage,
          },
        },
      },
    });

    return mockComponentSet;
  }

  it('should skip when package has no Apex', () => {
    mockSfpmPackage.hasApex = false;
    const task = createTask();
    expect(task.canRun()).toBe(false);
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

    mockDeploy.pollStatus.mockResolvedValue({
      response: {
        done: true,
        success: false,
        numberComponentsDeployed: 0,
        numberComponentsTotal: 10,
        details: {
          componentFailures: [{fullName: 'MyClass', problem: 'compile error'}],
        },
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
      codeCoverage: [{numLocations: 100, numLocationsNotCovered: 50, name: 'LowCovClass'}],
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
    const result = await task.exec();
    expect(result).toEqual({enrichments: {testCoverage: 80}});
  });

  it('should calculate coverage across multiple coverage entries', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [
        {numLocations: 100, numLocationsNotCovered: 10, name: 'ClassA'},
        {numLocations: 50, numLocationsNotCovered: 5, name: 'ClassB'},
      ],
    });

    const task = createTask();
    const result = await task.exec();
    // 90 + 45 = 135 covered / 150 total = 90%
    expect(result).toEqual({enrichments: {testCoverage: 90}});
  });

  it('should emit task:validation:start and task:validation:complete events', async () => {
    setupSuccessfulDeploy();

    const startEvents: any[] = [];
    const completeEvents: any[] = [];
    buildBus.on('task:validate:start', (evt) => startEvents.push(evt));
    buildBus.on('task:validate:complete', (evt) => completeEvents.push(evt));

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

  it('should return testCoverage in enrichments', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 100, numLocationsNotCovered: 25, name: 'CoverClass'}],
    });

    const task = createTask();
    const result = await task.exec();
    expect(result).toEqual({enrichments: {testCoverage: 75}});
  });

  it('should handle zero coverage lines gracefully', async () => {
    setupSuccessfulDeploy({
      codeCoverage: [{numLocations: 0, numLocationsNotCovered: 0, name: 'EmptyClass'}],
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
      return new ValidationTask(
        {sfpmPackage: mockSfpmPackage, projectDirectory: '/tmp/test', logger: mockLogger, sink: buildBus.forPackage(packageName)},
        {validationOrg: buildOrg, testOnly: true},
      );
    }

    /** Helper to build an SDK-shaped TestResult for mocking reportAsyncResults. */
    function buildApexTestResult(options?: {
      passing?: number;
      failing?: number;
      tests?: any[];
      codecoverage?: any[];
    }) {
      const passing = options?.passing ?? 2;
      const failing = options?.failing ?? 0;
      const testsRan = passing + failing;

      const defaultTests = Array.from({length: passing}, (_, i) => ({
        apexClass: {id: `cls-${i}`, name: `TestClass${i}`, namespacePrefix: '', fullName: `TestClass${i}`},
        methodName: `testMethod${i}`,
        outcome: 'Pass',
        runTime: 0.1 + i * 0.01,
        message: null,
        stackTrace: null,
        id: `res-${i}`,
        queueItemId: `q-${i}`,
        asyncApexJobId: 'test-run-123',
        apexLogId: null,
        testTimestamp: new Date().toISOString(),
        fullName: `TestClass${i}.testMethod${i}`,
      }));

      return {
        summary: {
          failRate: `${Math.round((failing / testsRan) * 100)}%`,
          testsRan,
          orgId: '00D000000000000',
          outcome: failing > 0 ? 'Failed' : 'Passed',
          passing,
          failing,
          skipped: 0,
          passRate: `${Math.round((passing / testsRan) * 100)}%`,
          skipRate: '0%',
          testStartTime: new Date().toISOString(),
          testExecutionTimeInMs: 100,
          testTotalTimeInMs: 150,
          commandTimeInMs: 200,
          hostname: 'test.salesforce.com',
          username: buildOrg,
          testRunId: 'test-run-123',
          userId: '005000000000000',
        },
        tests: options?.tests ?? defaultTests,
        codecoverage: options?.codecoverage,
      };
    }

    function setupTestServiceMock(apexResult?: any) {
      mockTestService.buildAsyncPayload.mockResolvedValue({
        classNames: 'MyTest,OtherTest',
        testLevel: 'RunSpecifiedTests',
      });
      mockTestService.runTestAsynchronous.mockResolvedValue({testRunId: 'test-run-123'});
      mockTestService.reportAsyncResults.mockResolvedValue(
        apexResult ?? buildApexTestResult(),
      );
    }

    it('should run tests via TestService without deploying', async () => {
      setupTestServiceMock();
      const task = createTestOnlyTask();
      await task.exec();

      expect(mockTestService.buildAsyncPayload).toHaveBeenCalledWith(
        'RunSpecifiedTests',
        undefined,
        'MyTest,OtherTest',
      );
      expect(mockTestService.runTestAsynchronous).toHaveBeenCalled();
      // Should NOT call getComponentSet (no deploy)
      expect(mockSfpmPackage.getComponentSet).not.toHaveBeenCalled();
    });

    it('should pass when all tests succeed', async () => {
      setupTestServiceMock(buildApexTestResult({passing: 5, failing: 0}));
      const task = createTestOnlyTask();
      await expect(task.exec()).resolves.toBeUndefined();
    });

    it('should throw BuildError when tests fail', async () => {
      setupTestServiceMock(buildApexTestResult({
        passing: 2,
        failing: 1,
        tests: [
          {apexClass: {id: '1', name: 'MyTest', namespacePrefix: '', fullName: 'MyTest'}, methodName: 'testMethod', outcome: 'Fail', message: 'assertion failed', stackTrace: null, runTime: 0.05, id: 'r1', queueItemId: 'q1', asyncApexJobId: 'test-run-123', apexLogId: null, testTimestamp: '', fullName: 'MyTest.testMethod'},
          {apexClass: {id: '2', name: 'MyTest', namespacePrefix: '', fullName: 'MyTest'}, methodName: 'testOther', outcome: 'Pass', message: null, stackTrace: null, runTime: 0.05, id: 'r2', queueItemId: 'q2', asyncApexJobId: 'test-run-123', apexLogId: null, testTimestamp: '', fullName: 'MyTest.testOther'},
          {apexClass: {id: '3', name: 'OtherTest', namespacePrefix: '', fullName: 'OtherTest'}, methodName: 'testFoo', outcome: 'Pass', message: null, stackTrace: null, runTime: 0.03, id: 'r3', queueItemId: 'q3', asyncApexJobId: 'test-run-123', apexLogId: null, testTimestamp: '', fullName: 'OtherTest.testFoo'},
        ],
      }));

      const task = createTestOnlyTask();
      await expect(task.exec()).rejects.toThrow(BuildError);
      await expect(task.exec()).rejects.toThrow('Apex test(s) failed');
    });

    it('should not assert coverage in test-only mode', async () => {
      setupTestServiceMock(buildApexTestResult({passing: 2, failing: 0}));
      const task = createTestOnlyTask();
      const result = await task.exec();
      expect(result).toBeUndefined();
    });

    it('should record coverage but not assert it in test-only mode', async () => {
      setupTestServiceMock(buildApexTestResult({
        passing: 2,
        failing: 0,
        codecoverage: [
          {apexId: 'cls1', name: 'MyClass', type: 'ApexClass', numLinesCovered: 30, numLinesUncovered: 70, percentage: '30%', coveredLines: [], uncoveredLines: []},
        ],
      }));
      const task = createTestOnlyTask();
      // 30% coverage would fail the 75% threshold, but test-only mode doesn't assert
      const result = await task.exec();
      expect(result).toEqual({enrichments: {testCoverage: 30}});
    });

    it('should emit events with RunSpecifiedTests test level', async () => {
      setupTestServiceMock();

      const startEvents: any[] = [];
      buildBus.on('task:validate:start', (evt) => startEvents.push(evt));

      const task = createTestOnlyTask();
      await task.exec();

      expect(startEvents[0]).toMatchObject({
        testLevel: 'RunSpecifiedTests',
      });
    });

    it('should skip when package has no Apex', () => {
      mockSfpmPackage.hasApex = false;
      const task = createTestOnlyTask();
      expect(task.canRun()).toBe(false);
    });
  });

});
