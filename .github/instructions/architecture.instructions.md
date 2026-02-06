---
description: Core architecture patterns and best practices for SFPM
applyTo: 'packages/core/src/**/*.ts'
---

## Package Structure

### Core Directories

- **artifacts/** - Artifact management (reading, writing, versioning)
- **package/** - Package core logic (builders, installers, assemblers)
- **project/** - Project configuration and management
- **git/** - Git integration
- **apex/** - Apex parsing and analysis
- **org/** - Salesforce org operations
- **types/** - TypeScript type definitions and interfaces
- **utils/** - Utility functions

### File Organization

Group related functionality:
- Keep interfaces with implementations
- Separate strategies into `strategies/` subdirectory
- Keep assembly steps in `steps/` subdirectory
- Use `types.ts` for local type definitions

## Strategy Pattern

Used extensively for flexible behavior selection (build strategies, installation strategies, analysis strategies).

**Favor composition over inheritance** - Always.

### Implementation Pattern

```typescript
// 1. Define the strategy interface
export interface InstallationStrategy {
    canHandle(sourceType: InstallationSourceType, package: SfpmPackage): boolean;
    getMode(): InstallationMode;
    install(package: SfpmPackage, targetOrg: string): Promise<void>;
}

// 2. Implement strategies
export class UnlockedVersionStrategy implements InstallationStrategy {
    canHandle(sourceType: InstallationSourceType, package: SfpmPackage): boolean {
        return package instanceof SfpmUnlockedPackage 
            && !!package.packageVersionId
            && sourceType === InstallationSourceType.BuiltArtifact;
    }
    // ... implementation
}

// 3. Strategy selection in orchestrator
private selectStrategy(): InstallationStrategy {
    const strategy = this.strategies.find(s => 
        s.canHandle(this.sourceType, this.package)
    );
    
    if (!strategy) {
        throw new StrategyError(
            'installation',
            `No strategy found for ${this.sourceType}`,
            this.strategies.map(s => s.constructor.name)
        );
    }
    
    return strategy;
}
```

### Guidelines

- **Order matters**: List strategies from most specific to most general
- **Single responsibility**: Each strategy handles one specific scenario
- **Clear conditions**: `canHandle()` should have explicit, testable conditions
- **Throw StrategyError**: When no strategy matches, use StrategyError with available options

## Event Emitter Pattern

Used for progress tracking and event-driven architecture.

### Event Naming Convention

Use namespaced events: `<domain>:<action>`

```typescript
// Build events
'build:start', 'build:complete', 'build:error', 'build:skip'

// Install events  
'install:start', 'install:complete', 'install:error'
'connection:start', 'connection:complete'
'deployment:start', 'deployment:progress', 'deployment:complete'
'version-install:start', 'version-install:progress', 'version-install:complete'
```

### Implementation Pattern

```typescript
export class PackageInstaller extends EventEmitter {
    public async install(): Promise<void> {
        // Emit start event
        this.emit('install:start', {
            timestamp: new Date(),
            packageName: this.package.packageName,
            packageVersion: this.package.version,
        });

        try {
            await this.executeInstallation();
            
            // Emit success event
            this.emit('install:complete', {
                timestamp: new Date(),
                packageName: this.package.packageName,
                success: true,
            });
        } catch (error) {
            // Emit error event
            this.emit('install:error', {
                timestamp: new Date(),
                packageName: this.package.packageName,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    }
}
```

### Event Payload Guidelines

- Always include `timestamp: new Date()`
- Include identifying information (packageName, targetOrg, etc.)
- Keep payloads serializable (no functions, classes)
- Use consistent property names across similar events

## Service Layer Pattern

Services provide a clean interface to external systems (org, git, artifacts).

### Service Characteristics

- **Stateless or minimal state**: Services should be reusable
- **Optional dependencies**: Logger and org should be optional in constructor
- **Error handling**: Wrap external errors in SFPM error types
- **Method organization**: Group by functionality (local artifacts, remote artifacts, org operations)

```typescript
export class ArtifactService {
    constructor(
        private logger?: Logger,
        private org?: Org
    ) {}

    // Local artifact methods
    public hasLocalArtifacts(projectDir: string, packageName: string): boolean {
        // Implementation
    }

    // Org artifact methods (require org)
    public async isArtifactInstalled(packageName: string): Promise<boolean> {
        if (!this.org) {
            throw new Error('Org connection required for isArtifactInstalled');
        }
        // Implementation
    }

    // Future: Remote artifact methods
    // public async fetchFromNpm(packageName: string): Promise<Artifact> { }
}
```

## Factory Pattern

Used for object creation with complex initialization.

### When to Use

- Object creation requires configuration lookup
- Multiple object types based on package type
- Centralized creation logic

```typescript
export class PackageFactory {
    constructor(private projectConfig: ProjectConfig) {}

    public createFromName(packageName: string): SfpmPackage {
        const packageConfig = this.projectConfig.getPackageConfig(packageName);
        
        if (!packageConfig) {
            throw new Error(`Package not found: ${packageName}`);
        }

        // Create appropriate package type
        switch (packageConfig.type) {
            case PackageType.Unlocked:
                return new SfpmUnlockedPackage(packageConfig, this.projectConfig);
            case PackageType.Source:
                return new SfpmSourcePackage(packageConfig, this.projectConfig);
            default:
                throw new Error(`Unsupported package type: ${packageConfig.type}`);
        }
    }
}
```

## Dependency Injection

Pass dependencies through constructors, not global singletons.

### Pattern

```typescript
// Good: Dependencies injected
export class PackageInstaller {
    constructor(
        private projectConfig: ProjectConfig,
        private options: InstallerOptions,
        private logger?: Logger
    ) {}
}

// Avoid: Reading from global state or requiring imports
export class PackageInstaller {
    private projectConfig = readProjectConfig(); // ❌ Hard to test
}
```

## Async/Await Best Practices

### Always await external operations

```typescript
// File I/O
await fs.readJson(path);
await fs.writeJson(path, data);

// Salesforce operations
await org.getConnection();
await connection.query(soql);

// External processes
await exec('git rev-parse HEAD');
```

### Parallel operations when independent

```typescript
// Sequential (slower)
const manifest = await getManifest();
const metadata = await getMetadata();

// Parallel (faster)
const [manifest, metadata] = await Promise.all([
    getManifest(),
    getMetadata()
]);
```

## Testing Patterns

### Unit Test Structure

```typescript
describe('PackageInstaller', () => {
    let installer: PackageInstaller;
    let mockConfig: ProjectConfig;
    let mockLogger: Logger;

    beforeEach(() => {
        // Setup mocks
        mockConfig = { /* ... */ };
        mockLogger = {
            info: vi.fn(),
            error: vi.fn(),
            // ...
        };
        
        installer = new PackageInstaller(mockConfig, {}, mockLogger);
    });

    describe('installPackage', () => {
        it('should emit install:start event', async () => {
            const startSpy = vi.fn();
            installer.on('install:start', startSpy);
            
            await installer.install();
            
            expect(startSpy).toHaveBeenCalledWith(
                expect.objectContaining({
                    packageName: 'test-package',
                    timestamp: expect.any(Date)
                })
            );
        });
    });
});
```

### Mock External Dependencies

```typescript
vi.mock('fs-extra', () => ({
    readJson: vi.fn(),
    writeJson: vi.fn(),
    // ...
}));

vi.mock('@salesforce/core', () => ({
    Org: {
        create: vi.fn()
    }
}));
```

## Code Style Guidelines

### Composition Over Inheritance

**Favor composition over extension** - Use interfaces and utility functions instead of class hierarchies.

```typescript
// Good - Composition with interface
interface Renderable {
    render(): string;
}

function renderWithBorder(item: Renderable): string {
    return `\n---\n${item.render()}\n---\n`;
}

class MyComponent implements Renderable {
    render(): string { return 'content'; }
}

// Avoid - Deep inheritance hierarchies
class BaseComponent {
    render(): string { return ''; }
}

class MyComponent extends BaseComponent {
    // ...
}
```

**Use composition for shared behavior:**
- Interfaces for contracts
- Utility functions for shared operations
- Dependency injection for collaborators
- Strategy pattern for behavior variants

**When inheritance is acceptable:**
- Framework requirements (EventEmitter, etc.)
- Clear "is-a" relationships with minimal hierarchy (e.g. package domain models)

### Naming Conventions

- **Classes**: PascalCase - `PackageInstaller`, `ArtifactService`
- **Interfaces**: PascalCase - `InstallationStrategy`, `AssemblyStep`
- **Methods**: camelCase - `installPackage()`, `getLocalArtifacts()`
- **Constants**: UPPER_SNAKE_CASE - `DEFAULT_TIMEOUT`, `MAX_RETRIES`
- **Private methods**: camelCase with private keyword
- **Event names**: kebab-case - `install:start`, `deployment:progress`

### Method Organization

Order methods logically within classes:

1. Constructor
2. Public methods (most important first)
3. Private methods (in order they're called)

### Comments

- Use JSDoc for public APIs
- Explain "why" not "what" in inline comments
- Keep comments up to date with code changes

```typescript
/**
 * Install a package using the appropriate strategy
 * @param packageName - Name of the package to install
 * @returns Promise that resolves when installation completes
 * @throws {InstallationError} If installation fails
 */
public async installPackage(packageName: string): Promise<void> {
    // Check for artifacts first to show correct version
    // (artifacts have actual version, sfdx-project.json has .NEXT)
    const artifactInfo = this.artifactService.getLocalArtifactInfo(
        this.projectDir,
        packageName
    );
    
    // ... implementation
}
```

## Import Organization

Group and order imports:

```typescript
// 1. Node.js built-ins
import path from 'path';
import { EventEmitter } from 'events';

// 2. External packages
import fs from 'fs-extra';
import { Org } from '@salesforce/core';

// 3. Internal imports (relative)
import { PackageFactory } from '../package-factory.js';
import { Logger } from '../../types/logger.js';
import { InstallationError } from '../../types/errors.js';
```
