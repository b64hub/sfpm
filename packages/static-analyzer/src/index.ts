// Apex AST infrastructure
export {ApexAstSerializer} from './apex/apex-ast-serializer.js';
export type {RawAstResponse, SerializerOptions} from './apex/apex-ast-serializer.js';
export {ApexParser} from './apex/apex-parser.js';
export type {ApexClassInfo} from './apex/apex-parser.js';
export {default as ApexService} from './apex/apex-service.js';

export {ApexReferenceExtractor} from './dependency/apex-reference-extractor.js';

export type {ApexTypeReference} from './dependency/apex-reference-extractor.js';
// Dependency analysis
export {MetadataDependencyService} from './dependency/metadata-dependency-service.js';
export {SymbolRegistry} from './dependency/symbol-registry.js';
export type {AnalyzablePackage} from './dependency/symbol-registry.js';
// Jorje types
export type * as jorje from './types/jorje.js';
