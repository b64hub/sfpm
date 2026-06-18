import type SfpmPackage from '../sfpm-package.js';

import {Logger} from '../../types/logger.js';
import {SfpmPackageContent} from '../../types/package.js';

/**
 * Interface for package analyzers
 */
export interface PackageAnalyzer {
  analyze(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageContent>>;
  isEnabled(sfpmPackage: SfpmPackage): boolean;
  name: string;
}

/**
 * Constructor signature for package analyzers
 */
export type AnalyzerConstructor = new (logger?: Logger) => PackageAnalyzer;

/**
 * Registry to store and retrieve package analyzers
 */
export class AnalyzerRegistry {
  private static analyzers: AnalyzerConstructor[] = [];

  /**
   * Retrieves all registered analyzers
   */
  public static getAnalyzers(logger?: Logger): PackageAnalyzer[] {
    return AnalyzerRegistry.analyzers.map(Ctor => new Ctor(logger));
  }

  /**
   * Registers an analyzer
   */
  public static register(analyzer: AnalyzerConstructor) {
    AnalyzerRegistry.analyzers.push(analyzer);
  }
}

/**
 * Decorator to register a package analyzer implementation
 */
export function RegisterAnalyzer() {
  return (constructor: AnalyzerConstructor) => {
    AnalyzerRegistry.register(constructor);
  };
}
