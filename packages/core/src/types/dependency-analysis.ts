import SfpmPackage from '../package/sfpm-package.js';

/**
 * A single reference to a symbol from another package.
 */
export interface SymbolReference {
  /** The type of reference (e.g., "ApexClass", "ApexInterface") */
  referenceType: string;
  /** Source file where the reference was found (relative path) */
  sourceFile: string;
  /** The referenced symbol name (e.g., "MyService") */
  symbol: string;
}

/**
 * A missing dependency: a package that is referenced but not declared as a dependency.
 */
export interface MissingDependency {
  /** The undeclared package name */
  packageName: string;
  /** All references to symbols from this undeclared package */
  references: SymbolReference[];
}

/**
 * Result of analyzing a single package's dependencies.
 */
export interface DependencyReport {
  /** Dependencies that are referenced in code but not declared */
  missingDependencies: MissingDependency[];
  /** The package that was analyzed */
  packageName: string;
}

/**
 * Interface for static metadata dependency analysis.
 *
 * Implementations validate that declared package dependencies cover actual
 * metadata references (e.g., Apex type references between packages).
 *
 * Stateful: call `initialize()` once with all packages to build the
 * symbol registry, then call `analyze()` per package.
 */
export interface DependencyAnalyzer {
  /**
   * Analyze a single package's references against the registry.
   * Returns a report of missing (undeclared) dependencies.
   */
  analyze(pkg: SfpmPackage): Promise<DependencyReport>;

  /**
   * Build the internal symbol registry from all workspace packages.
   * Must be called before `analyze()`.
   */
  initialize(packages: SfpmPackage[]): Promise<void>;
}
