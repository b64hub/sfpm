import {describe, it, expect, vi, beforeEach} from 'vitest';

import {PackageType} from '../../../src/types/package.js';
import FTAnalyzer from '../../../src/package/analyzers/ft-analyzer.js';
import {SfpmMetadataPackage} from '../../../src/package/sfpm-package.js';
import {Logger} from '../../../src/types/logger.js';

function createMockField(fullName: string, trackFeedHistory: string | boolean) {
  return {
    fullName,
    parseXml: vi.fn().mockResolvedValue({
      CustomField: {trackFeedHistory: String(trackFeedHistory)},
    }),
  };
}

function createMockPackage(
  options: {customFields?: ReturnType<typeof createMockField>[]; type?: PackageType} = {},
) {
  const {customFields = [], type = PackageType.Source} = options;
  return {
    type,
    customFields,
    setFtFields: vi.fn(),
    packageDirectory: '/tmp/project/force-app',
  } as unknown as SfpmMetadataPackage;
}

describe('FTAnalyzer', () => {
  let analyzer: FTAnalyzer;
  let mockLogger: Logger;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLogger = {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      log: vi.fn(),
      trace: vi.fn(),
      warn: vi.fn(),
    };
    analyzer = new FTAnalyzer(mockLogger);
  });

  describe('isEnabled', () => {
    it('should return true for source packages', () => {
      const pkg = createMockPackage({type: PackageType.Source});
      expect(analyzer.isEnabled(pkg)).toBe(true);
    });

    it('should return true for unlocked packages', () => {
      const pkg = createMockPackage({type: PackageType.Unlocked});
      expect(analyzer.isEnabled(pkg)).toBe(true);
    });

    it('should return false for data packages', () => {
      const pkg = createMockPackage({type: PackageType.Data});
      expect(analyzer.isEnabled(pkg)).toBe(false);
    });
  });

  describe('analyze', () => {
    it('should return empty when package has no custom fields', async () => {
      const pkg = createMockPackage({customFields: []});
      const result = await analyzer.analyze(pkg);
      expect(result).toEqual({});
      expect(pkg.setFtFields).not.toHaveBeenCalled();
    });

    it('should detect fields with trackFeedHistory enabled', async () => {
      const fields = [
        createMockField('Account.MyField__c', true),
        createMockField('Account.OtherField__c', false),
        createMockField('Contact.TrackedField__c', true),
      ];
      const pkg = createMockPackage({customFields: fields});

      await analyzer.analyze(pkg);

      expect(pkg.setFtFields).toHaveBeenCalledWith([
        'Account.MyField__c',
        'Contact.TrackedField__c',
      ]);
    });

    it('should set empty array when no fields have feed tracking', async () => {
      const fields = [
        createMockField('Account.Field1__c', false),
        createMockField('Account.Field2__c', false),
      ];
      const pkg = createMockPackage({customFields: fields});

      await analyzer.analyze(pkg);

      expect(pkg.setFtFields).toHaveBeenCalledWith([]);
    });

    it('should handle XML parse errors gracefully', async () => {
      const badField = {
        fullName: 'Account.Bad__c',
        parseXml: vi.fn().mockRejectedValue(new Error('XML parse error')),
      };
      const pkg = createMockPackage({customFields: [badField as any]});

      const result = await analyzer.analyze(pkg);

      expect(result).toEqual({});
      expect(mockLogger.trace).toHaveBeenCalled();
    });

    it('should handle missing CustomField in XML', async () => {
      const field = {
        fullName: 'Account.Weird__c',
        parseXml: vi.fn().mockResolvedValue({CustomField: undefined}),
      };
      const pkg = createMockPackage({customFields: [field as any]});

      await analyzer.analyze(pkg);

      expect(pkg.setFtFields).toHaveBeenCalledWith([]);
    });
  });
});
