import type {
  DependencyAnalyzer, DependencyReport, MissingDependency, SfpmPackage, SymbolReference,
} from '@b64hub/sfpm-core';

import fs from 'fs-extra';
import path from 'node:path';

import {ApexAstSerializer} from '../apex/apex-ast-serializer.js';
import {ApexReferenceExtractor, ApexTypeReference} from './apex-reference-extractor.js';
import {SymbolRegistry} from './symbol-registry.js';

/**
 * Stateful service for static metadata dependency analysis.
 *
 * Call `initialize()` once with all workspace packages to build the
 * symbol registry, then call `analyze()` per package to validate
 * that declared dependencies cover actual Apex type references.
 *
 * Implements the `DependencyAnalyzer` interface from `@b64hub/sfpm-core`.
 */
export class MetadataDependencyService implements DependencyAnalyzer {
  private declaredDeps = new Map<string, Set<string>>();
  private readonly extractor = new ApexReferenceExtractor();
  private initialized = false;
  private readonly projectDir: string;
  private readonly registry = new SymbolRegistry();
  private readonly serializer: ApexAstSerializer;

  constructor(projectDir: string, serializer?: ApexAstSerializer) {
    this.projectDir = projectDir;
    this.serializer = serializer ?? new ApexAstSerializer();
  }

  /**
   * Analyze a single package's Apex type references against the registry.
   *
   * Returns a report of dependencies that are referenced in code but
   * not declared in the package's `dependencies` field.
   */
  public async analyze(pkg: SfpmPackage): Promise<DependencyReport> {
    if (!this.initialized) {
      throw new Error('MetadataDependencyService.initialize() must be called before analyze()');
    }

    const packageDir = pkg.packageDirectory;
    if (!packageDir) {
      return {missingDependencies: [], packageName: pkg.packageName};
    }

    const references = await this.extractApexReferences(packageDir);

    // Group references by the package that owns the referenced symbol
    const refsByPackage = new Map<string, SymbolReference[]>();

    for (const ref of references) {
      const owningPackage = this.registry.resolve(ref.name);

      // Skip unresolved (standard types, managed packages)
      if (!owningPackage) continue;

      // Skip self-references
      if (owningPackage === pkg.packageName) continue;

      // Check if this dependency is declared
      const declared = this.declaredDeps.get(pkg.packageName) ?? new Set();
      if (declared.has(owningPackage)) continue;

      // This is a missing dependency
      const existing = refsByPackage.get(owningPackage) ?? [];
      existing.push({
        referenceType: 'ApexClass',
        sourceFile: ref.sourceFile,
        symbol: ref.name,
      });
      refsByPackage.set(owningPackage, existing);
    }

    // Build the report grouped by missing dependency
    const missingDependencies: MissingDependency[] = [];
    for (const [packageName, refs] of refsByPackage) {
      missingDependencies.push({packageName, references: refs});
    }

    return {
      missingDependencies,
      packageName: pkg.packageName,
    };
  }

  /**
   * Build the symbol registry from all workspace packages.
   * Also caches declared dependencies for each package.
   */
  public async initialize(packages: SfpmPackage[]): Promise<void> {
    for (const pkg of packages) {
      const pkgPath = pkg.packageDefinition?.path;
      if (!pkgPath) continue;

      this.registry.registerPackage(
        {packageName: pkg.packageName, path: pkgPath},
        this.projectDir,
      );

      // Cache declared dependencies for comparison
      const deps = new Set<string>();
      if (pkg.dependencies) {
        for (const depName of Object.keys(pkg.dependencies)) {
          deps.add(depName);
        }
      }

      this.declaredDeps.set(pkg.packageName, deps);
    }

    this.initialized = true;
  }

  /**
   * Scan all Apex class files in a package directory and extract type references.
   */
  private async extractApexReferences(packagePath: string): Promise<ApexTypeReference[]> {
    const classesDir = path.join(packagePath, 'main', 'default', 'classes');
    const exists = await fs.pathExists(classesDir);
    if (!exists) return [];

    const files = await fs.readdir(classesDir);
    const apexFiles = files.filter(f => f.endsWith('.cls'));

    const allRefs: ApexTypeReference[] = [];

    for (const file of apexFiles) {
      const filePath = path.join(classesDir, file);
      try {
        const sourceCode = await fs.readFile(filePath, 'utf8'); // eslint-disable-line no-await-in-loop -- sequential: Jorje server handles one file at a time
        const ast = await this.serializer.serialize(sourceCode); // eslint-disable-line no-await-in-loop
        const refs = this.extractor.extract(ast, file);
        allRefs.push(...refs);
      } catch {
        // AST parsing failed for this file — skip silently
        // (e.g., syntax errors, binary not available)
      }
    }

    return allRefs;
  }
}
