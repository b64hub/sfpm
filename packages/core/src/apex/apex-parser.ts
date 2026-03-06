import fs from 'fs-extra';
import path from 'node:path';

import type * as jorje from '../types/jorje.js';

import {ApexAstSerializer} from './apex-ast-serializer.js';

export type ApexClassInfo = {
  isTest: boolean;
  name: string;
  path: string;
  type: 'Class' | 'Enum' | 'Interface' | 'Trigger';
};

export class ApexParser {
  private serializer: ApexAstSerializer;

  constructor(serializer?: ApexAstSerializer) {
    this.serializer = serializer || new ApexAstSerializer();
  }

  public async classify(filePath: string): Promise<ApexClassInfo> {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) {
      return {
        isTest: false,
        name: 'Unknown',
        path: path.basename(filePath),
        type: 'Class',
      };
    }

    const sourceCode = await fs.readFile(filePath, 'utf8');
    const info = await this.getInfo(sourceCode);
    info.path = path.basename(filePath);
    return info;
  }

  public async classifyBulk(filePaths: string[]): Promise<ApexClassInfo[]> {
    // Filter to only include paths that are actual files (not directories)
    const validPaths: string[] = [];
    const validIndices: number[] = [];
    for (const [i, filePath] of filePaths.entries()) {
      // eslint-disable-next-line no-await-in-loop -- we want to check each file sequentially to manage memory usage
      const stat = await fs.stat(filePath).catch(() => null);
      if (stat?.isFile()) {
        validPaths.push(filePath);
        validIndices.push(i);
      }
    }

    const sourceCodes = await Promise.all(validPaths.map(filePath => fs.readFile(filePath, 'utf8')));
    const infos = await this.getInfoBulk(sourceCodes);
    for (const [index, info] of infos.entries()) {
      info.path = path.basename(validPaths[index]);
    }

    // Return results in original order, with empty placeholders for skipped paths
    const results: ApexClassInfo[] = filePaths.map(filePath => ({
      isTest: false,
      name: 'Unknown',
      path: path.basename(filePath),
      type: 'Class' as const,
    }));
    for (const [resultIndex, originalIndex] of validIndices.entries()) {
      results[originalIndex] = infos[resultIndex];
    }

    return results;
  }

  private async getInfo(sourceCode: string): Promise<ApexClassInfo> {
    try {
      const ast = await this.serializer.serialize(sourceCode);
      return this.mapAstToInfo(ast);
    } catch {
      return this.runHeuristics(sourceCode);
    }
  }

  /**
   * Bulkified API for high-volume processing.
   */
  private async getInfoBulk(contents: string[]): Promise<ApexClassInfo[]> {
    return Promise.all(contents.map(c => this.getInfo(c)));
  }

  private mapAstToInfo(ast: jorje.ParserOutput): ApexClassInfo {
    const {unit} = ast;

    // Initialize defaults
    let type: ApexClassInfo['type'] = 'Class';
    let name: string = 'Unknown';
    let isTest: boolean = false;

    // CompilationUnit is a discriminated union based on "@class"
    switch (unit['@class']) {
    case 'apex.jorje.data.ast.CompilationUnit$ClassDeclUnit': {
      // Narrow to ClassDeclUnit to access body
      const classUnit = unit as jorje.ClassDeclUnit;
      const {body} = classUnit;

      type = 'Class';
      name = body.name.value;

      // Extract modifiers from body and check for @isTest annotation
      isTest = (body.modifiers || []).some(m =>
        m['@class'] === 'apex.jorje.data.ast.Modifier$Annotation'
        && (m as jorje.Annotation).name.value.toLowerCase() === 'istest');
      break;
    }

    case 'apex.jorje.data.ast.CompilationUnit$EnumDeclUnit': {
      const enumUnit = unit as jorje.EnumDeclUnit;
      type = 'Enum';
      name = enumUnit.body.name.value;
      isTest = false;
      break;
    }

    case 'apex.jorje.data.ast.CompilationUnit$InterfaceDeclUnit': {
      // Interfaces also have a body containing the name
      const interfaceUnit = unit as jorje.InterfaceDeclUnit;
      type = 'Interface';
      name = interfaceUnit.body.name.value;
      isTest = false;
      break;
    }

    case 'apex.jorje.data.ast.CompilationUnit$TriggerDeclUnit': {
      // Triggers have the name directly on the unit node
      const triggerUnit = unit as jorje.TriggerDeclUnit;
      type = 'Trigger';
      name = triggerUnit.name.value;
      isTest = false;
      break;
    }
    }

    return {
      isTest, name, path: '', type,
    };
  }

  private runHeuristics(sourceCode: string): ApexClassInfo {
    return {
      isTest: sourceCode.toLowerCase().includes('@istest'),
      name: 'Unknown',
      path: '',
      type: sourceCode.includes(' interface ') ? 'Interface' : 'Class',
    };
  }
}
