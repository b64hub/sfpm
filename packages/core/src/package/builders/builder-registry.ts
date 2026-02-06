import EventEmitter from "node:events";
import { Logger } from "../../types/logger.js";
import { PackageType } from "../../types/package.js";
import SfpmPackage from "../sfpm-package.js";
import { UnlockedBuildEvents, SourceBuildEvents } from "../../types/events.js";

/**
 * Interface for specific package builder implementations (Strategy Pattern)
 * Builders can emit events by extending EventEmitter
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
    sfpmPackage: SfpmPackage,
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
