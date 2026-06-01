import fs from 'fs-extra';
import path from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {ApexClassifier} from '../../src/apex/apex-classifier.js';

describe('ApexClassifier', () => {
  let classifier: ApexClassifier;
  let runtimeDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    classifier = new ApexClassifier();
    runtimeDir = path.join(
      process.cwd(),
      'packages/core/test/.runtime',
      `apex-classifier-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await fs.ensureDir(runtimeDir);
  });

  afterEach(async () => {
    await fs.remove(runtimeDir);
  });

  async function writeApexFile(fileName: string, sourceCode: string): Promise<string> {
    const filePath = path.join(runtimeDir, fileName);
    await fs.writeFile(filePath, sourceCode, 'utf8');
    return filePath;
  }

  describe('classify', () => {
    it('identifies @isTest classes case-insensitively', async () => {
      for (const annotation of ['@isTest', '@IsTest', '@ISTEST', '@istest']) {
        const filePath = await writeApexFile(
          'AccountServiceTest.cls',
          `${annotation}\nprivate class AccountServiceTest {}`,
        );

        const result = await classifier.classify(filePath);
        expect(result.isTest).toBe(true);
        expect(result.name).toBe('AccountServiceTest');
      }
    });

    it('identifies regular classes as non-test', async () => {
      const filePath = await writeApexFile(
        'InvoiceService.cls',
        'public with sharing class InvoiceService {}',
      );

      await expect(classifier.classify(filePath)).resolves.toEqual({
        isTest: false,
        name: 'InvoiceService',
        path: 'InvoiceService.cls',
      });
    });

    it('extracts class names', async () => {
      const filePath = await writeApexFile(
        'OpportunityService.cls',
        'public inherited sharing class OpportunityService extends BaseService {}',
      );

      const result = await classifier.classify(filePath);
      expect(result.name).toBe('OpportunityService');
    });

    it('handles empty sources', async () => {
      const filePath = await writeApexFile('Empty.cls', '');

      await expect(classifier.classify(filePath)).resolves.toEqual({
        isTest: false,
        name: 'Unknown',
        path: 'Empty.cls',
      });
    });

    it('ignores @isTest that only appears in comments', async () => {
      const filePath = await writeApexFile(
        'CommentSafe.cls',
        [
          '// @isTest',
          '/*',
          '@IsTest',
          '*/',
          'public class CommentSafe {}',
        ].join('\n'),
      );

      const result = await classifier.classify(filePath);
      expect(result.isTest).toBe(false);
      expect(result.name).toBe('CommentSafe');
    });

    it('returns default for non-existent files', async () => {
      const result = await classifier.classify('/nonexistent/path.cls');
      expect(result).toEqual({
        isTest: false,
        name: 'Unknown',
        path: 'path.cls',
      });
    });
  });

  describe('classifyBulk', () => {
    it('processes multiple files in order', async () => {
      const classFile = await writeApexFile('BulkClass.cls', 'public class BulkClass {}');
      const testFile = await writeApexFile('BulkTest.cls', '@isTest private class BulkTest {}');

      await expect(classifier.classifyBulk([classFile, testFile])).resolves.toEqual([
        {isTest: false, name: 'BulkClass', path: 'BulkClass.cls'},
        {isTest: true, name: 'BulkTest', path: 'BulkTest.cls'},
      ]);
    });
  });
});
