import {describe, expect, test} from 'vitest';

import {SfpmUnlockedPackage} from '../../src/package/sfpm-package.js';

describe('SfpmPackage', () => {
  describe('getVersionNumber', () => {
    function createPackage(version?: string): SfpmUnlockedPackage {
      const pkg = new SfpmUnlockedPackage('test-pkg', '/tmp/project');
      if (version) {
        pkg.version = version;
      }

      return pkg;
    }

    test('returns semver format by default', () => {
      const pkg = createPackage('1.0.0-NEXT');
      expect(pkg.getVersionNumber()).toBe('1.0.0-NEXT');
    });

    test('returns semver format explicitly', () => {
      const pkg = createPackage('1.2.3-7');
      expect(pkg.getVersionNumber('semver')).toBe('1.2.3-7');
    });

    test('returns salesforce format', () => {
      const pkg = createPackage('1.0.0-NEXT');
      expect(pkg.getVersionNumber('salesforce')).toBe('1.0.0.NEXT');
    });

    test('converts numeric build to salesforce format', () => {
      const pkg = createPackage('1.2.3-42');
      expect(pkg.getVersionNumber('salesforce')).toBe('1.2.3.42');
    });

    test('handles salesforce-format input normalised to npm', () => {
      // version setter normalizes '1.0.0.NEXT' → '1.0.0-NEXT'
      const pkg = createPackage('1.0.0.NEXT');
      expect(pkg.getVersionNumber('semver')).toBe('1.0.0-NEXT');
      expect(pkg.getVersionNumber('salesforce')).toBe('1.0.0.NEXT');
    });

    test('strips build number when includeBuildNumber is false', () => {
      const pkg = createPackage('1.2.3-NEXT');
      expect(pkg.getVersionNumber('semver', {includeBuildNumber: false})).toBe('1.2.3');
      expect(pkg.getVersionNumber('salesforce', {includeBuildNumber: false})).toBe('1.2.3');
    });

    test('strips numeric build number when includeBuildNumber is false', () => {
      const pkg = createPackage('2.0.1-7');
      expect(pkg.getVersionNumber('semver', {includeBuildNumber: false})).toBe('2.0.1');
    });

    test('returns undefined when no version is set', () => {
      const pkg = createPackage();
      expect(pkg.getVersionNumber()).toBeUndefined();
      expect(pkg.getVersionNumber('salesforce')).toBeUndefined();
    });
  });
});
