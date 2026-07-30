import { beforeEach, describe, expect, it } from 'vitest';

import type * as jorje from '../../src/types/jorje.js';
import { ApexReferenceExtractor } from '../../src/dependency/apex-reference-extractor.js';

const CLASS_TYPE_REF = 'apex.jorje.data.ast.TypeRefs$ClassTypeRef';
const IDENTIFIER_CLASS = 'apex.jorje.data.Identifiers$LocationIdentifier';

function createAst(unit: unknown): jorje.ParserOutput {
  return {
    '@class': 'apex.jorje.semantic.compiler.parser.ParserOutput',
    hiddenTokenMap: [],
    internalErrors: [],
    parseErrors: [],
    unit: unit as jorje.CompilationUnit,
  } as unknown as jorje.ParserOutput;
}

function createClassTypeRef(name: string) {
  return {
    '@class': CLASS_TYPE_REF,
    names: [
      { '@class': IDENTIFIER_CLASS, value: name },
    ],
    typeArguments: [],
  };
}

describe('ApexReferenceExtractor', () => {
  let extractor: ApexReferenceExtractor;

  beforeEach(() => {
    extractor = new ApexReferenceExtractor();
  });

  it('extracts type references from ClassTypeRef nodes', () => {
    const ast = createAst({
      body: {
        returnType: createClassTypeRef('MyService'),
      },
    });

    expect(extractor.extract(ast, 'classes/MyClass.cls')).toEqual([
      { name: 'MyService', sourceFile: 'classes/MyClass.cls' },
    ]);
  });

  it('handles nested AST structures', () => {
    const ast = createAst({
      members: [
        {
          methods: [
            { parameterType: createClassTypeRef('MyService') },
          ],
        },
      ],
      nested: {
        expressions: [
          {
            resultType: createClassTypeRef('HelperService'),
          },
        ],
      },
    });

    expect(extractor.extract(ast, 'classes/Nested.cls')).toEqual([
      { name: 'MyService', sourceFile: 'classes/Nested.cls' },
      { name: 'HelperService', sourceFile: 'classes/Nested.cls' },
    ]);
  });

  it('deduplicates references', () => {
    const ast = createAst({
      refs: [
        createClassTypeRef('MyService'),
        { nested: createClassTypeRef('MyService') },
        createClassTypeRef('myservice'),
      ],
    });

    expect(extractor.extract(ast, 'classes/Dedup.cls')).toEqual([
      { name: 'MyService', sourceFile: 'classes/Dedup.cls' },
    ]);
  });

  it('returns empty array for AST with no type references', () => {
    const ast = createAst({
      body: {
        members: [
          { name: 'doWork' },
        ],
      },
    });

    expect(extractor.extract(ast, 'classes/NoRefs.cls')).toEqual([]);
  });

  it('sets sourceFile on all returned references', () => {
    const sourceFile = 'classes/SourceFile.cls';
    const ast = createAst({
      refs: [
        createClassTypeRef('MyService'),
        createClassTypeRef('HelperService'),
      ],
    });

    const references = extractor.extract(ast, sourceFile);

    expect(references).toHaveLength(2);
    expect(references.every(ref => ref.sourceFile === sourceFile)).toBe(true);
  });

  it('handles empty names array gracefully', () => {
    const ast = createAst({
      refs: [
        {
          '@class': CLASS_TYPE_REF,
          names: [],
          typeArguments: [],
        },
      ],
    });

    expect(extractor.extract(ast, 'classes/EmptyNames.cls')).toEqual([]);
  });

  it('handles missing value on identifier gracefully', () => {
    const ast = createAst({
      refs: [
        {
          '@class': CLASS_TYPE_REF,
          names: [
            { '@class': IDENTIFIER_CLASS },
          ] as unknown as jorje.Identifier[],
          typeArguments: [],
        },
      ],
    });

    expect(extractor.extract(ast, 'classes/MissingValue.cls')).toEqual([]);
  });
});
