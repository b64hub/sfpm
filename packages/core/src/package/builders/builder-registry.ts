import { PackageType } from "../../types/package.js";

/**
 * Interface for specific package builder implementations (Strategy Pattern)
 */
export interface Builder {
    exec(): Promise<any>;
}

/**
 * Constructor signature for package builders
 */
export type BuilderConstructor = new (
    workingDirectory: string,
    sfpmPackage: any
) => Builder;

/**
 * Registry to store and retrieve package builders by type
 */
export class BuilderRegistry {
    private static builders = new Map<string, BuilderConstructor>();

    /**
     * Registers a builder for a specific package type
     */
    public static register(type: string, builder: BuilderConstructor) {
        BuilderRegistry.builders.set(type.toLowerCase(), builder);
    }

    /**
     * Retrieves a builder for a specific package type
     */
    public static getBuilder(type: string): BuilderConstructor | undefined {
        return BuilderRegistry.builders.get(type.toLowerCase());
    }
}

/**
 * Decorator to register a package builder implementation
 */
export function RegisterBuilder(type: PackageType) {
    return (constructor: BuilderConstructor) => {
        BuilderRegistry.register(type, constructor);
    };
}
