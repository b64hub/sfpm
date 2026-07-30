import type * as jorje from '../types/jorje.js';

/**
 * A type reference extracted from an Apex AST.
 */
export interface ApexTypeReference {
  /** The top-level type name (e.g., "MyService") */
  name: string;
  /** The source file path (set by the caller, not the extractor) */
  sourceFile: string;
}

const CLASS_TYPE_REF = 'apex.jorje.data.ast.TypeRefs$ClassTypeRef';

/**
 * Extracts Apex type references from a Jorje AST using recursive JSON search.
 *
 * Walks the entire AST tree and collects all `ClassTypeRef` nodes,
 * extracting the first identifier from each `names` array as the
 * referenced type name.
 *
 * This is a "good enough" approach for V1: we don't need to know
 * where in the class the reference appears, only that it exists.
 */
export class ApexReferenceExtractor {
  /**
   * Extract all type references from a parsed Apex AST.
   */
  public extract(ast: jorje.ParserOutput, sourceFile: string): ApexTypeReference[] {
    const typeRefs: ApexTypeReference[] = [];
    const seen = new Set<string>();

    this.walkForTypeRefs(ast, (names: jorje.Identifier[]) => {
      if (names.length === 0) return;

      // First identifier is the top-level type name
      const name = names[0].value;
      if (!name || seen.has(name.toLowerCase())) return;

      seen.add(name.toLowerCase());
      typeRefs.push({name, sourceFile});
    });

    return typeRefs;
  }

  /**
   * Recursively walk a JSON-like structure, calling `onTypeRef` for every
   * node whose `@class` matches `ClassTypeRef`.
   */
  private walkForTypeRefs(
    node: unknown,
    onTypeRef: (names: jorje.Identifier[]) => void,
  ): void {
    if (node === null || node === undefined || typeof node !== 'object') return;

    if (Array.isArray(node)) {
      for (const item of node) {
        this.walkForTypeRefs(item, onTypeRef);
      }

      return;
    }

    const obj = node as Record<string, unknown>;

    // Check if this node is a ClassTypeRef
    if (obj['@class'] === CLASS_TYPE_REF && Array.isArray(obj.names)) {
      onTypeRef(obj.names as jorje.Identifier[]);
    }

    // Recurse into all values
    for (const value of Object.values(obj)) {
      if (typeof value === 'object' && value !== null) {
        this.walkForTypeRefs(value, onTypeRef);
      }
    }
  }
}
