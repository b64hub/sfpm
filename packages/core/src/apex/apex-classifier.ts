import fs from 'fs-extra';
import path from 'node:path';

export type ApexClassInfo = {
  isTest: boolean;
  name: string;
  path: string;
};

/**
 * Lightweight Apex classifier using regex heuristics.
 *
 * Detects `@IsTest` annotations to distinguish test classes from
 * regular classes without requiring the Jorje AST parser.
 * Sufficient for enriching the SfpmPackage domain model.
 *
 * Triggers, enums, and interfaces are separate metadata types
 * and don't need regex detection — SDR handles them.
 *
 * For full AST analysis (type reference extraction), use the
 * `@b64hub/sfpm-static-analyzer` package instead.
 */
export class ApexClassifier {
  /**
   * Classify a single Apex file by reading its source.
   */
  public async classify(filePath: string): Promise<ApexClassInfo> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      return {isTest: false, name: 'Unknown', path: path.basename(filePath)};
    }

    const sourceCode = await fs.readFile(filePath, 'utf8');
    return {
      isTest: isTestClass(sourceCode),
      name: extractClassName(sourceCode),
      path: path.basename(filePath),
    };
  }

  /**
   * Classify multiple Apex files in bulk.
   * Returns results in the same order as the input paths.
   * Non-file paths get a default classification.
   */
  public async classifyBulk(filePaths: string[]): Promise<ApexClassInfo[]> {
    const validPaths: string[] = [];
    const validIndices: number[] = [];

    for (const [i, filePath] of filePaths.entries()) {
      // eslint-disable-next-line no-await-in-loop -- sequential stat to manage memory on large projects
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) {
        validPaths.push(filePath);
        validIndices.push(i);
      }
    }

    const sourceCodes = await Promise.all(validPaths.map(fp => fs.readFile(fp, 'utf8')));

    const results: ApexClassInfo[] = filePaths.map(fp => ({
      isTest: false, name: 'Unknown', path: path.basename(fp),
    }));

    for (const [resultIdx, originalIdx] of validIndices.entries()) {
      const src = sourceCodes[resultIdx];
      results[originalIdx] = {
        isTest: isTestClass(src),
        name: extractClassName(src),
        path: path.basename(validPaths[resultIdx]),
      };
    }

    return results;
  }
}

const IS_TEST_PATTERN = /@istest\b/i;
const CLASS_NAME_PATTERN = /\bclass\s+(\w+)/i;
const COMMENT_PATTERN = /\/\*[\s\S]*?\*\/|\/\/.*$/gm;

function stripComments(source: string): string {
  return source.replaceAll(COMMENT_PATTERN, '');
}

function isTestClass(sourceCode: string): boolean {
  return IS_TEST_PATTERN.test(stripComments(sourceCode));
}

function extractClassName(sourceCode: string): string {
  return CLASS_NAME_PATTERN.exec(stripComments(sourceCode))?.[1] ?? 'Unknown';
}
