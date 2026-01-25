import { Logger } from "../../types/logger.js";
import { SfpmPackageContent } from "../../types/package.js";
import SfpmPackage from "../sfpm-package.js";

/**
 * Interface for package analyzers
 */
export interface PackageAnalyzer {
    isEnabled(sfpmPackage: SfpmPackage): boolean;
    analyze(sfpmPackage: SfpmPackage): Promise<Partial<SfpmPackageContent>>;
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
     * Registers an analyzer
     */
    public static register(analyzer: AnalyzerConstructor) {
        AnalyzerRegistry.analyzers.push(analyzer);
    }

    /**
     * Retrieves all registered analyzers
     */
    public static getAnalyzers(logger?: Logger): PackageAnalyzer[] {
        return AnalyzerRegistry.analyzers.map(Ctor => new Ctor(logger));
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
