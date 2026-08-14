import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

// PackageService is a thin wrapper over @salesforce/packaging + @salesforce/core.
// Automocking both gives us: constructor-spies for every SDK class (call args
// inspectable via `vi.mocked(Class).mock.calls`), auto-mocked static/instance
// methods (return values settable per test via `Class.method`/`Class.prototype.method`),
// and untouched plain-data exports (event name constants, Package2VersionStatus).
vi.mock('@salesforce/packaging');
vi.mock('@salesforce/core');

import {Lifecycle, SfProject} from '@salesforce/core';
import {Duration} from '@salesforce/kit';
import {
  Package, PackageEvents, PackageVersion, PackageVersionEvents, SubscriberPackageVersion,
} from '@salesforce/packaging';

import PackageService from '../../src/package/package-service.js';

describe('PackageService', () => {
  let mockLogger: any;
  let lifecycleListeners: Record<string, (data: any) => void>;
  let mockLifecycle: {on: ReturnType<typeof vi.fn>; removeAllListeners: ReturnType<typeof vi.fn>};

  function createService(orgOverrides: Record<string, any> = {}) {
    const mockConnection = {tooling: {query: vi.fn()}} as any;
    const mockOrg = {
      determineIfDevHubOrg: vi.fn().mockReturnValue(true),
      getConnection: vi.fn().mockReturnValue(mockConnection),
      ...orgOverrides,
    };
    const service = new PackageService(mockOrg as any, mockLogger);
    return {mockConnection, mockOrg, service};
  }

  /** Fire a registered lifecycle listener as if the SDK emitted that event. */
  function emit(event: string, data: any): void {
    lifecycleListeners[event]?.(data);
  }

  beforeEach(() => {
    vi.resetAllMocks();

    mockLogger = {
      debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
    };

    lifecycleListeners = {};
    mockLifecycle = {
      on: vi.fn((event: string, handler: (data: any) => void) => {
        lifecycleListeners[event] = handler;
      }),
      removeAllListeners: vi.fn((event?: string) => {
        if (event) delete lifecycleListeners[event];
      }),
    };
    vi.mocked(Lifecycle.getInstance).mockReturnValue(mockLifecycle as any);
    vi.mocked(SfProject.resolve).mockResolvedValue({fake: 'project'} as any);
  });

  // -------------------------------------------------------------------------
  // Connection guards
  // -------------------------------------------------------------------------

  describe('connection guards', () => {
    it('requireDevhubConnection throws when the org is not a devhub', async () => {
      const {service} = createService({determineIfDevHubOrg: vi.fn().mockReturnValue(false)});

      await expect(service.listPackages()).rejects.toThrow('Connected org must be a devhub to use this method');
    });

    it('requireDevhubConnection throws when there is no target org', async () => {
      const service = new PackageService(undefined as any, mockLogger);

      await expect(service.listPackages()).rejects.toThrow('Connected org must be a devhub to use this method');
    });

    it('requireTargetOrgConnection throws when there is no target org', async () => {
      const service = new PackageService(undefined as any, mockLogger);

      await expect(service.listInstalledPackages()).rejects.toThrow('Target org must be connected');
    });
  });

  // -------------------------------------------------------------------------
  // createPackage
  // -------------------------------------------------------------------------

  describe('createPackage', () => {
    it('creates a package with defaults and logs the result', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(Package.create).mockResolvedValue({Id: '0HoXXX'} as any);

      const result = await service.createPackage('my-pkg', 'Unlocked', 'force-app');

      expect(Package.create).toHaveBeenCalledWith(
        mockConnection,
        {fake: 'project'},
        expect.objectContaining({
          description: '',
          name: 'my-pkg',
          noNamespace: false,
          orgDependent: false,
          packageType: 'Unlocked',
          path: 'force-app',
        }),
      );
      expect(result).toEqual({Id: '0HoXXX'});
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('0HoXXX'));
    });

    it('passes through explicit options', async () => {
      const {service} = createService();
      vi.mocked(Package.create).mockResolvedValue({Id: '0HoXXX'} as any);

      await service.createPackage('my-pkg', 'Managed', 'force-app', {
        description: 'desc', noNamespace: true, orgDependent: true,
      });

      expect(Package.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          description: 'desc', noNamespace: true, orgDependent: true, packageType: 'Managed',
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // createPackageVersion
  // -------------------------------------------------------------------------

  describe('createPackageVersion', () => {
    it('creates a version and returns the result on success', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(PackageVersion.create).mockResolvedValue({
        Status: 'Success', SubscriberPackageVersionId: '04tXXX',
      } as any);

      const result = await service.createPackageVersion('0HoXXX', {installationkey: 'key123', versionnumber: '1.0.0.1'});

      expect(PackageVersion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          connection: mockConnection,
          installationkey: 'key123',
          packageId: '0HoXXX',
          project: {fake: 'project'},
          versionnumber: '1.0.0.1',
        }),
        expect.anything(),
      );
      expect(result).toEqual({Status: 'Success', SubscriberPackageVersionId: '04tXXX'});
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('04tXXX'));
    });

    it('throws a formatted error when creation fails', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.create).mockResolvedValue({
        Error: ['bad thing', 'other bad thing'], Status: 'Error',
      } as any);

      await expect(service.createPackageVersion('0HoXXX')).rejects.toThrow('Package version creation failed: (1) bad thing; (2) other bad thing');
    });

    it('uses a 5s polling frequency when wait + skipvalidation are both set, else 30s', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.create).mockResolvedValue({Status: 'Success'} as any);

      await service.createPackageVersion('0HoXXX', {skipvalidation: true, wait: 10});
      expect(vi.mocked(PackageVersion.create).mock.calls[0][1]).toEqual({frequency: Duration.seconds(5), timeout: Duration.minutes(10)});

      await service.createPackageVersion('0HoXXX', {wait: 10});
      expect(vi.mocked(PackageVersion.create).mock.calls[1][1]).toEqual({frequency: Duration.seconds(30), timeout: Duration.minutes(10)});
    });

    it('forwards progress events to the onProgress callback and cleans up listeners', async () => {
      const {service} = createService();
      const onProgress = vi.fn();
      vi.mocked(PackageVersion.create).mockImplementation(async () => {
        emit(PackageVersionEvents.create.progress, {Status: 'InProgress'});
        return {Status: 'Success'} as any;
      });

      await service.createPackageVersion('0HoXXX', {}, onProgress);

      expect(onProgress).toHaveBeenCalledWith({Status: 'InProgress'});
      expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith(PackageVersionEvents.create.progress);
      expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith(PackageVersionEvents.create['preserve-files']);
    });

    it('logs preserved-file locations at debug level', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.create).mockImplementation(async () => {
        emit(PackageVersionEvents.create['preserve-files'], {location: '/tmp/preserved', message: 'kept'});
        return {Status: 'Success'} as any;
      });

      await service.createPackageVersion('0HoXXX');

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('/tmp/preserved'));
    });

    it('requires a devhub connection', async () => {
      const {service} = createService({determineIfDevHubOrg: vi.fn().mockReturnValue(false)});

      await expect(service.createPackageVersion('0HoXXX')).rejects.toThrow('devhub');
    });
  });

  // -------------------------------------------------------------------------
  // deletePackage / deletePackageVersion
  // -------------------------------------------------------------------------

  describe('deletePackage', () => {
    it('deletes by default', async () => {
      const {service} = createService();
      vi.mocked(Package.prototype.delete).mockResolvedValue({success: true} as any);

      const result = await service.deletePackage('0HoXXX');

      expect(Package.prototype.delete).toHaveBeenCalled();
      expect(Package.prototype.undelete).not.toHaveBeenCalled();
      expect(result).toEqual({success: true});
      expect(vi.mocked(Package).mock.calls[0][0]).toMatchObject({packageAliasOrId: '0HoXXX'});
    });

    it('undeletes when requested', async () => {
      const {service} = createService();
      vi.mocked(Package.prototype.undelete).mockResolvedValue({success: true} as any);

      await service.deletePackage('0HoXXX', {undelete: true});

      expect(Package.prototype.undelete).toHaveBeenCalled();
      expect(Package.prototype.delete).not.toHaveBeenCalled();
    });

    it('falls back to an undefined project when not in a project directory', async () => {
      const {service} = createService();
      vi.mocked(SfProject.resolve).mockRejectedValue(new Error('not a project'));
      vi.mocked(Package.prototype.delete).mockResolvedValue({success: true} as any);

      await service.deletePackage('0HoXXX');

      expect(vi.mocked(Package).mock.calls[0][0]).toMatchObject({project: undefined});
    });
  });

  describe('deletePackageVersion', () => {
    it('deletes by default and undeletes when requested', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.delete).mockResolvedValue({success: true} as any);
      vi.mocked(PackageVersion.prototype.undelete).mockResolvedValue({success: true} as any);

      await service.deletePackageVersion('04tXXX');
      expect(PackageVersion.prototype.delete).toHaveBeenCalled();

      await service.deletePackageVersion('04tXXX', {undelete: true});
      expect(PackageVersion.prototype.undelete).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getPackageVersionBySubscriberId
  // -------------------------------------------------------------------------

  describe('getPackageVersionBySubscriberId', () => {
    it('queries by subscriber id and returns the first record', async () => {
      const {mockConnection, service} = createService();
      const record = {Package2Id: '0HoXXX', SubscriberPackageVersionId: '04tXXX'};
      mockConnection.tooling.query.mockResolvedValue({records: [record]});

      const result = await service.getPackageVersionBySubscriberId('04tXXX');

      expect(mockConnection.tooling.query).toHaveBeenCalledWith(expect.stringContaining('04tXXX'));
      expect(mockConnection.tooling.query.mock.calls[0][0]).toContain('FROM Package2Version');
      expect(result).toEqual(record);
    });

    it('logs and rethrows when the query fails', async () => {
      const {mockConnection, service} = createService();
      mockConnection.tooling.query.mockRejectedValue(new Error('SOQL error'));

      await expect(service.getPackageVersionBySubscriberId('04tXXX')).rejects.toThrow('SOQL error');
      expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('04tXXX'));
    });
  });

  // -------------------------------------------------------------------------
  // getVersionCreateStatus
  // -------------------------------------------------------------------------

  describe('getVersionCreateStatus', () => {
    it('delegates to PackageVersion.getCreateStatus with the devhub connection', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(PackageVersion.getCreateStatus).mockResolvedValue({Status: 'Success'} as any);

      const result = await service.getVersionCreateStatus('08cXXX');

      expect(PackageVersion.getCreateStatus).toHaveBeenCalledWith('08cXXX', mockConnection);
      expect(result).toEqual({Status: 'Success'});
    });
  });

  // -------------------------------------------------------------------------
  // installPackage
  // -------------------------------------------------------------------------

  describe('installPackage', () => {
    beforeEach(() => {
      vi.mocked(SubscriberPackageVersion.prototype.getId).mockResolvedValue('05iXXX');
      vi.mocked(SubscriberPackageVersion.prototype.install).mockResolvedValue({Status: 'Success'} as any);
    });

    it('installs with default security/upgrade types and no installation key', async () => {
      const {service} = createService();

      await service.installPackage('04tXXX');

      expect(vi.mocked(SubscriberPackageVersion.prototype.install).mock.calls[0][0]).toEqual({
        ApexCompileType: 'all',
        Password: undefined,
        SecurityType: 'none',
        SubscriberPackageVersionKey: '05iXXX',
        UpgradeType: 'mixed-mode',
      });
    });

    it('maps explicit security/upgrade types and forwards the installation key', async () => {
      const {service} = createService();

      await service.installPackage('04tXXX', {
        installationKey: 'my-key', securityType: 'AllUsers', upgradeType: 'Delete',
      });

      expect(vi.mocked(SubscriberPackageVersion).mock.calls[0][0]).toMatchObject({password: 'my-key'});
      expect(vi.mocked(SubscriberPackageVersion.prototype.install).mock.calls[0][0]).toMatchObject({
        Password: 'my-key', SecurityType: 'full', UpgradeType: 'delete-only',
      });
    });

    it('waits for publish only when publishWait is set', async () => {
      const {service} = createService();
      vi.mocked(SubscriberPackageVersion.prototype.waitForPublish).mockResolvedValue();

      await service.installPackage('04tXXX', {publishWait: 5});
      expect(SubscriberPackageVersion.prototype.waitForPublish).toHaveBeenCalled();

      vi.mocked(SubscriberPackageVersion.prototype.waitForPublish).mockClear();
      await service.installPackage('04tXXX');
      expect(SubscriberPackageVersion.prototype.waitForPublish).not.toHaveBeenCalled();
    });

    it('passes polling options to install only when wait is set', async () => {
      const {service} = createService();

      await service.installPackage('04tXXX', {wait: 15});
      expect(vi.mocked(SubscriberPackageVersion.prototype.install).mock.calls[0][1]).toBeDefined();

      await service.installPackage('04tXXX');
      expect(vi.mocked(SubscriberPackageVersion.prototype.install).mock.calls[1][1]).toBeUndefined();
    });

    it('forwards install status events to onProgress and always cleans up listeners', async () => {
      const {service} = createService();
      const onProgress = vi.fn();
      vi.mocked(SubscriberPackageVersion.prototype.install).mockImplementation(async () => {
        emit(PackageEvents.install.status, {Status: 'InProgress'});
        return {Status: 'Success'} as any;
      });

      await service.installPackage('04tXXX', {}, onProgress);

      expect(onProgress).toHaveBeenCalledWith({Status: 'InProgress'});
      expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith(PackageEvents.install.warning);
      expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith(PackageEvents.install.status);
    });

    it('returns the install result', async () => {
      const {service} = createService();
      vi.mocked(SubscriberPackageVersion.prototype.install).mockResolvedValue({Id: '0HfXXX', Status: 'Success'} as any);

      const result = await service.installPackage('04tXXX');
      expect(result).toEqual({Id: '0HfXXX', Status: 'Success'});
    });
  });

  // -------------------------------------------------------------------------
  // isSubscriberVersionInstalled / listInstalledPackages / preload / cache
  // -------------------------------------------------------------------------

  describe('installed-package cache', () => {
    it('isSubscriberVersionInstalled queries directly when the cache is empty', async () => {
      const {mockConnection, service} = createService();
      mockConnection.tooling.query.mockResolvedValue({records: [{Id: 'a0B1'}]});

      const installed = await service.isSubscriberVersionInstalled('04tXXX');

      expect(installed).toBe(true);
      expect(mockConnection.tooling.query).toHaveBeenCalledWith(expect.stringContaining('04tXXX'));
    });

    it('isSubscriberVersionInstalled returns false and warns when the query fails', async () => {
      const {mockConnection, service} = createService();
      mockConnection.tooling.query.mockRejectedValue(new Error('boom'));

      const installed = await service.isSubscriberVersionInstalled('04tXXX');

      expect(installed).toBe(false);
      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('preloadInstalledPackages populates the cache and subsequent reads skip the org', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(SubscriberPackageVersion.installedList).mockResolvedValue([
        {SubscriberPackageVersionId: '04tAAA'} as any,
      ]);

      await service.preloadInstalledPackages();

      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('1'));

      const list = await service.listInstalledPackages();
      expect(list).toEqual([{SubscriberPackageVersionId: '04tAAA'}]);
      expect(SubscriberPackageVersion.installedList).toHaveBeenCalledTimes(1); // not called again

      const installedA = await service.isSubscriberVersionInstalled('04tAAA');
      const installedB = await service.isSubscriberVersionInstalled('04tBBB');
      expect(installedA).toBe(true);
      expect(installedB).toBe(false);
      expect(mockConnection.tooling.query).not.toHaveBeenCalled(); // cache hit, no query
    });

    it('clearCache forces subsequent reads to hit the org again', async () => {
      const {service} = createService();
      vi.mocked(SubscriberPackageVersion.installedList).mockResolvedValue([{SubscriberPackageVersionId: '04tAAA'} as any]);

      await service.preloadInstalledPackages();
      service.clearCache();
      vi.mocked(SubscriberPackageVersion.installedList).mockResolvedValue([]);

      const list = await service.listInstalledPackages();
      expect(list).toEqual([]);
      expect(SubscriberPackageVersion.installedList).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // listPackages / listPackageVersions
  // -------------------------------------------------------------------------

  describe('listPackages', () => {
    it('delegates to Package.list with the devhub connection', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(Package.list).mockResolvedValue([{Id: '0HoXXX'}] as any);

      const result = await service.listPackages();

      expect(Package.list).toHaveBeenCalledWith(mockConnection);
      expect(result).toEqual([{Id: '0HoXXX'}]);
    });
  });

  describe('listPackageVersions', () => {
    it('resolves a project and forwards it when available', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(Package.listVersions).mockResolvedValue([] as any);

      await service.listPackageVersions({packages: ['my-pkg']} as any);

      expect(Package.listVersions).toHaveBeenCalledWith(mockConnection, {fake: 'project'}, {packages: ['my-pkg']});
    });

    it('falls back to an undefined project when resolution fails', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(SfProject.resolve).mockRejectedValue(new Error('not a project'));
      vi.mocked(Package.listVersions).mockResolvedValue([] as any);

      await service.listPackageVersions();

      expect(Package.listVersions).toHaveBeenCalledWith(mockConnection, undefined, undefined);
    });
  });

  // -------------------------------------------------------------------------
  // promoteVersion
  // -------------------------------------------------------------------------

  describe('promoteVersion', () => {
    it('is a no-op when already released', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.getData).mockResolvedValue({IsReleased: true} as any);

      await service.promoteVersion('04tXXX');

      expect(PackageVersion.prototype.promote).not.toHaveBeenCalled();
      expect(mockLogger.debug).toHaveBeenCalledWith(expect.stringContaining('already released'));
    });

    it('promotes successfully when not yet released', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.getData).mockResolvedValue({IsReleased: false} as any);
      vi.mocked(PackageVersion.prototype.promote).mockResolvedValue({success: true} as any);

      await expect(service.promoteVersion('04tXXX')).resolves.toBeUndefined();
    });

    it('recovers when promote reports failure but the server-side state shows released', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.getData)
      .mockResolvedValueOnce({IsReleased: false} as any) // initial check
      .mockResolvedValueOnce({IsReleased: true} as any); // verify-after-failure
      vi.mocked(PackageVersion.prototype.promote).mockResolvedValue({errors: ['nope'], success: false} as any);

      await expect(service.promoteVersion('04tXXX')).resolves.toBeUndefined();
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('promoted server-side'));
    });

    it('rethrows when promote fails and the server-side state is still not released', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.getData)
      .mockResolvedValueOnce({IsReleased: false} as any)
      .mockResolvedValueOnce({IsReleased: false} as any);
      vi.mocked(PackageVersion.prototype.promote).mockResolvedValue({errors: ['nope'], success: false} as any);

      await expect(service.promoteVersion('04tXXX')).rejects.toThrow('Failed to promote package version 04tXXX');
    });

    it('recovers when the promote call itself rejects but the server-side state shows released', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.getData)
      .mockResolvedValueOnce({IsReleased: false} as any)
      .mockResolvedValueOnce({IsReleased: true} as any);
      vi.mocked(PackageVersion.prototype.promote).mockRejectedValue(new Error('network blip'));

      await expect(service.promoteVersion('04tXXX')).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // reportPackageVersion / setLogger
  // -------------------------------------------------------------------------

  describe('reportPackageVersion', () => {
    it('reports with the resolved project and verbose flag', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.report).mockResolvedValue({Package2Id: '0HoXXX'} as any);

      const result = await service.reportPackageVersion('04tXXX', {verbose: true});

      expect(PackageVersion.prototype.report).toHaveBeenCalledWith(true);
      expect(result).toEqual({Package2Id: '0HoXXX'});
    });
  });

  describe('setLogger', () => {
    it('is chainable and swaps the logger used for subsequent calls', async () => {
      const {service} = createService();
      const newLogger = {
        debug: vi.fn(), error: vi.fn(), info: vi.fn(), trace: vi.fn(), warn: vi.fn(),
      };

      const returned = service.setLogger(newLogger as any);
      expect(returned).toBe(service);

      vi.mocked(Package.create).mockResolvedValue({Id: '0HoXXX'} as any);
      await service.createPackage('my-pkg', 'Unlocked', 'force-app');

      expect(newLogger.info).toHaveBeenCalled();
      expect(mockLogger.info).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // uninstallPackage
  // -------------------------------------------------------------------------

  describe('uninstallPackage', () => {
    it('logs and returns on success', async () => {
      const {service} = createService();
      vi.mocked(SubscriberPackageVersion.prototype.uninstall).mockResolvedValue({
        Status: 'Success', SubscriberPackageVersionId: '04tXXX',
      } as any);

      const result = await service.uninstallPackage('04tXXX');

      expect(result).toEqual({Status: 'Success', SubscriberPackageVersionId: '04tXXX'});
      expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('04tXXX'));
    });

    it('throws when the uninstall request errors', async () => {
      const {service} = createService();
      vi.mocked(SubscriberPackageVersion.prototype.uninstall).mockResolvedValue({
        Id: '06yXXX', Status: 'Error',
      } as any);

      await expect(service.uninstallPackage('04tXXX')).rejects.toThrow('Package uninstall failed for 04tXXX: 06yXXX');
    });

    it('forwards progress events and cleans up the listener', async () => {
      const {service} = createService();
      const onProgress = vi.fn();
      vi.mocked(SubscriberPackageVersion.prototype.uninstall).mockImplementation(async () => {
        emit(PackageEvents.uninstall, {Status: 'InProgress'});
        return {Status: 'Success'} as any;
      });

      await service.uninstallPackage('04tXXX', {}, onProgress);

      expect(onProgress).toHaveBeenCalledWith({Status: 'InProgress'});
      expect(mockLifecycle.removeAllListeners).toHaveBeenCalledWith(PackageEvents.uninstall);
    });
  });

  // -------------------------------------------------------------------------
  // updatePackage / updatePackageVersion
  // -------------------------------------------------------------------------

  describe('updatePackage', () => {
    it('maps input fields onto the SDK update payload', async () => {
      const {service} = createService();
      vi.mocked(Package.prototype.getId).mockReturnValue('0HoXXX' as any);
      vi.mocked(Package.prototype.update).mockResolvedValue({success: true} as any);

      await service.updatePackage('0HoXXX', {
        appAnalyticsEnabled: true, description: 'new desc', name: 'new name', skipAncestorCheck: true,
      });

      expect(Package.prototype.update).toHaveBeenCalledWith(
        {
          AppAnalyticsEnabled: true,
          Description: 'new desc',
          Id: '0HoXXX',
          Name: 'new name',
          PackageErrorUsername: undefined,
          RecommendedVersionId: undefined,
        },
        true,
      );
    });
  });

  describe('updatePackageVersion', () => {
    it('maps input fields onto the SDK update payload', async () => {
      const {service} = createService();
      vi.mocked(PackageVersion.prototype.update).mockResolvedValue({success: true} as any);

      await service.updatePackageVersion('04tXXX', {branch: 'main', tag: 'v1', versionName: 'Spring 25'});

      expect(PackageVersion.prototype.update).toHaveBeenCalledWith({
        Branch: 'main',
        InstallKey: undefined,
        Tag: 'v1',
        VersionDescription: undefined,
        VersionName: 'Spring 25',
      });
    });
  });

  // -------------------------------------------------------------------------
  // awaitPackageValidation / static awaitValidation polling
  // -------------------------------------------------------------------------

  describe('awaitPackageValidation / awaitValidation', () => {
    it('resolves immediately when the first poll is already terminal', async () => {
      vi.mocked(PackageVersion.getCreateVersionReport).mockResolvedValue({Status: 'Success'} as any);

      const result = await PackageService.awaitValidation('08cXXX', {} as any, {maxWaitMs: 1000, pollingIntervalMs: 5});

      expect(result).toEqual({Status: 'Success'});
      expect(PackageVersion.getCreateVersionReport).toHaveBeenCalledTimes(1);
    });

    it('polls until a terminal state is reached', async () => {
      vi.mocked(PackageVersion.getCreateVersionReport)
      .mockResolvedValueOnce({Status: 'InProgress'} as any)
      .mockResolvedValueOnce({Status: 'InProgress'} as any)
      .mockResolvedValueOnce({Status: 'Success'} as any);

      const result = await PackageService.awaitValidation('08cXXX', {} as any, {maxWaitMs: 1000, pollingIntervalMs: 5});

      expect(result).toEqual({Status: 'Success'});
      expect(PackageVersion.getCreateVersionReport).toHaveBeenCalledTimes(3);
    });

    it('throws a PackageValidationTimeout error when the deadline is exceeded', async () => {
      vi.mocked(PackageVersion.getCreateVersionReport).mockResolvedValue({Status: 'InProgress'} as any);

      const error = await PackageService.awaitValidation('08cXXX', {} as any, {maxWaitMs: 20, pollingIntervalMs: 5})
      .catch((error_: Error) => error_);

      expect(error).toBeInstanceOf(Error);
      expect((error as Error & {name: string}).name).toBe('PackageValidationTimeout');
    });

    it('delegates to the static poller using the devhub connection', async () => {
      const {mockConnection, service} = createService();
      vi.mocked(PackageVersion.getCreateVersionReport).mockResolvedValue({Status: 'Success'} as any);

      const result = await service.awaitPackageValidation('08cXXX', {maxWaitMs: 1000, pollingIntervalMs: 5});

      expect(result).toEqual({Status: 'Success'});
      expect(PackageVersion.getCreateVersionReport).toHaveBeenCalledWith('08cXXX', mockConnection);
    });
  });
});
