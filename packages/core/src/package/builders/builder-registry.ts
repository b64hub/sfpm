import { Logger } from "../../types/logger.js";
import { PackageType, SfpmPackageMetadata } from "../../types/package.js";

/**
 * Interface for specific package builder implementations (Strategy Pattern)
 */
export interface Builder {
    connect(username: string): Promise<void>;
    exec(): Promise<any>;
}

/**
 * Constructor signature for package builders
 */
export type BuilderConstructor = new (
    workingDirectory: string,
    sfpmPackage: SfpmPackageMetadata,
    logger?: Logger
) => Builder;

/**
 * Registry to store and retrieve package builders by type
 */
export class BuilderRegistry {
    private static builders = new Map<Omit<PackageType, 'managed'>, BuilderConstructor>();

    /**
     * Registers a builder for a specific package type
     */
    public static register(type: Omit<PackageType, 'managed'>, builder: BuilderConstructor) {
        BuilderRegistry.builders.set(type, builder);
    }

    /**
     * Retrieves a builder for a specific package type
     */
    public static getBuilder(type: Omit<PackageType, 'managed'>): BuilderConstructor | undefined {
        return BuilderRegistry.builders.get(type);
    }
}

/**
 * Decorator to register a package builder implementation
 */
export function RegisterBuilder(type: Omit<PackageType, 'managed'>) {
    return (constructor: BuilderConstructor) => {
        BuilderRegistry.register(type, constructor);
    };
}
