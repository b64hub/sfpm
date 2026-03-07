import {describe, expect, test} from 'vitest';

import {
  formatVersion,
  toVersionFormat,
} from '../../src/utils/version-utils.js';

describe('version-utils', () => {
  // =========================================================================
  // Primary API — toVersionFormat
  // =========================================================================

  describe('toVersionFormat', () => {
    describe('to semver (default)', () => {
      test('returns valid semver as-is', () => {
        expect(toVersionFormat('1.0.0')).toBe('1.0.0');
        expect(toVersionFormat('1.0.0-1')).toBe('1.0.0-1');
        expect(toVersionFormat('1.0.0-NEXT')).toBe('1.0.0-NEXT');
      });

      test('converts Salesforce 4-part to semver', () => {
        expect(toVersionFormat('1.0.0.1', 'semver')).toBe('1.0.0-1');
        expect(toVersionFormat('1.2.3.NEXT', 'semver')).toBe('1.2.3-NEXT');
        expect(toVersionFormat('0.1.0.LATEST', 'semver')).toBe('0.1.0-LATEST');
      });

      test('coerces loose formats', () => {
        expect(toVersionFormat('v1.0', 'semver')).toBe('1.0.0');
        expect(toVersionFormat('1', 'semver')).toBe('1.0.0');
      });

      test('throws on invalid input by default', () => {
        expect(() => toVersionFormat('not-a-version', 'semver')).toThrow('Invalid version format');
      });

      test('returns empty default for empty input', () => {
        expect(toVersionFormat('', 'semver')).toBe('0.0.0');
      });
    });

    describe('to salesforce', () => {
      test('converts semver to Salesforce format', () => {
        expect(toVersionFormat('0.1.0-NEXT', 'salesforce')).toBe('0.1.0.NEXT');
        expect(toVersionFormat('1.2.3-7', 'salesforce')).toBe('1.2.3.7');
        expect(toVersionFormat('1.0.0-LATEST', 'salesforce')).toBe('1.0.0.LATEST');
      });

      test('returns Salesforce format as-is', () => {
        expect(toVersionFormat('0.1.0.NEXT', 'salesforce')).toBe('0.1.0.NEXT');
        expect(toVersionFormat('1.2.3.42', 'salesforce')).toBe('1.2.3.42');
      });

      test('appends .NEXT to plain 3-part semver', () => {
        expect(toVersionFormat('1.0.0', 'salesforce')).toBe('1.0.0.NEXT');
      });

      test('returns empty default for empty input', () => {
        expect(toVersionFormat('', 'salesforce')).toBe('0.0.0.NEXT');
      });

      test('throws on unsupported format', () => {
        expect(() => toVersionFormat('not-a-version', 'salesforce')).toThrow('Invalid version format');
      });
    });

    describe('options.strict', () => {
      test('strict: false returns input as-is for invalid versions', () => {
        expect(toVersionFormat('garbage', 'semver', {strict: false})).toBe('garbage');
      });

      test('strict: true (default) throws for invalid versions', () => {
        expect(() => toVersionFormat('garbage', 'semver')).toThrow();
        expect(() => toVersionFormat('garbage', 'semver', {strict: true})).toThrow();
      });
    });

    describe('options.resolveTokens', () => {
      test('replaces NEXT with 0 when resolveTokens is true', () => {
        expect(toVersionFormat('1.0.0.NEXT', 'semver', {resolveTokens: true})).toBe('1.0.0-0');
      });

      test('replaces LATEST with 0 when resolveTokens is true', () => {
        expect(toVersionFormat('1.0.0.LATEST', 'semver', {resolveTokens: true})).toBe('1.0.0-0');
      });

      test('preserves numeric builds when resolveTokens is true', () => {
        expect(toVersionFormat('1.0.0.16', 'semver', {resolveTokens: true})).toBe('1.0.0-16');
      });

      test('preserves NEXT when resolveTokens is false (default)', () => {
        expect(toVersionFormat('1.0.0.NEXT', 'semver')).toBe('1.0.0-NEXT');
      });
    });

    describe('options.includeBuildNumber', () => {
      test('strips build segment when includeBuildNumber is false', () => {
        expect(toVersionFormat('1.0.0-7', 'semver', {includeBuildNumber: false})).toBe('1.0.0');
        expect(toVersionFormat('1.0.0-NEXT', 'semver', {includeBuildNumber: false})).toBe('1.0.0');
      });

      test('strips build from Salesforce format too', () => {
        expect(toVersionFormat('1.0.0.7', 'semver', {includeBuildNumber: false})).toBe('1.0.0');
      });

      test('includes build by default', () => {
        expect(toVersionFormat('1.0.0-7', 'semver')).toBe('1.0.0-7');
      });
    });

    describe('combined options', () => {
      test('strict: false + resolveTokens for comparison use-case', () => {
        expect(toVersionFormat('1.0.0.NEXT', 'semver', {strict: false, resolveTokens: true})).toBe('1.0.0-0');
        expect(toVersionFormat('garbage', 'semver', {strict: false, resolveTokens: true})).toBe('garbage');
        expect(toVersionFormat('1.0.0-1', 'semver', {strict: false, resolveTokens: true})).toBe('1.0.0-1');
      });
    });
  });

  // =========================================================================
  // formatVersion
  // =========================================================================

  describe('formatVersion', () => {
    test('formats to Salesforce by default', () => {
      expect(formatVersion(1, 2, 3, 4)).toBe('1.2.3.4');
      expect(formatVersion(0, 0, 0, 0)).toBe('0.0.0.0');
    });

    test('formats to semver when requested', () => {
      expect(formatVersion(1, 2, 3, 4, 'semver')).toBe('1.2.3-4');
      expect(formatVersion(0, 0, 0, 0, 'semver')).toBe('0.0.0-0');
    });

    test('explicit salesforce matches default', () => {
      expect(formatVersion(1, 2, 3, 4, 'salesforce')).toBe('1.2.3.4');
    });
  });
});
