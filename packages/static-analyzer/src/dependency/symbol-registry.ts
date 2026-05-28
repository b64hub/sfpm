import {ComponentSet} from '@salesforce/source-deploy-retrieve';

/**
 * Minimal shape needed from SfpmPackage to avoid tight coupling to core internals.
 */
export interface AnalyzablePackage {
  packageName: string;
  path: string;
}

/**
 * Maps metadata symbol names to the workspace package that owns them.
 *
 * Built by scanning each package's SDR `ComponentSet` and indexing
 * component names by type. Used to resolve cross-package references
 * during dependency analysis.
 */
export class SymbolRegistry {
  /** symbol name (case-insensitive key) → owning package name */
  private readonly apexSymbols = new Map<string, string>();

  /** Number of registered symbols (for diagnostics/testing). */
  public get size(): number {
    return this.apexSymbols.size;
  }

  /**
   * Register all Apex class symbols from a package's source directory.
   */
  public registerPackage(pkg: AnalyzablePackage, projectDir: string): void {
    const packagePath = `${projectDir}/${pkg.path}`;

    let componentSet: ComponentSet;
    try {
      componentSet = ComponentSet.fromSource(packagePath);
    } catch {
      return; // Package has no resolvable metadata — skip
    }

    for (const component of componentSet.getSourceComponents()) {
      if (component.type.id === 'apexclass' || component.type.id === 'apextrigger') {
        this.apexSymbols.set(component.name.toLowerCase(), pkg.packageName);
      }
    }
  }

  /**
   * Look up which package owns a given Apex symbol.
   * Returns the owning package name, or undefined if unresolved.
   */
  public resolve(symbolName: string): string | undefined {
    return this.apexSymbols.get(symbolName.toLowerCase());
  }
}
