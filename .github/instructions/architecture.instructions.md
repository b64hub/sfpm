---
description: Core architecture patterns and best practices for SFPM
applyTo: 'packages/core/src/**/*.ts'
---

## Package Structure

### Core Directories

- **project/** - Project definition providers, adapters, graph, versioning
  - **providers/** - `ProjectDefinitionProvider` interface + implementations
  - **providers/types/** - Workspace type definitions (`SfpmPackageConfig`, `WorkspacePackageJson`)
- **package/** - Package core logic (builders, installers, assemblers, creator)
- **artifacts/** - Artifact management (reading, writing, npm adapter)
- **orchestrator/** - Build and install orchestration
- **types/** - Canonical type definitions (`PackageDefinition`, `ProjectDefinition`)
- **utils/** - Scope utilities, version utilities, hashing
- **git/** - Git integration
- **apex/** - Apex parsing and analysis
- **org/** - Salesforce org operations

### File Organization

Group related functionality:
- Keep interfaces with implementations
- Separate strategies into `strategies/` subdirectory
- Keep assembly steps in `steps/` subdirectory
- Use `types.ts` or `types/` for local type definitions

## Project Definition System

### Source of Truth

SFPM supports two project modes, each with a different source of truth:

| Mode | Source of Truth | Provider | Detection |
|------|----------------|----------|-----------|
| **Workspace** | `package.json` files with `sfpm` config | `WorkspaceProvider` | `pnpm-workspace.yaml` or `package.json#workspaces` |
| **Legacy** | `sfdx-project.json` | `SfdxProjectProvider` | Fallback when no workspace config found |

Both modes produce the same canonical `ProjectDefinition` type. All downstream code works with `ProjectDefinition` — never with raw file formats.

### Canonical Types

```typescript
// The universal package representation — fully decoupled from @salesforce/core
interface PackageDefinition {
  name: string;           // Scoped npm name (e.g. "@b64/sfpm-artifact")
  path: string;           // Relative path from project root
  version: string;        // Always semver (e.g. "1.2.0")
  type: PackageType;      // 'unlocked' | 'source' | 'data'
  default?: boolean;      // Whether this is the default package
  packageId?: string;     // Salesforce Package2 ID (0Ho prefix)
  dependencies?: Record<string, string>;         // Workspace deps with semver constraints
  managedDependencies?: Record<string, string>;  // External deps with 04t version IDs
  metadataDependencies?: { seed?: string; unpackaged?: string };
  packageOptions?: PackageOptions;               // Build/deploy/hook config
}

interface ProjectDefinition {
  packages: PackageDefinition[];
  sfdcLoginUrl?: string;
  sourceApiVersion?: string;
  sourceBehaviorOptions?: string[];
}
```

**Key decisions:**
- `name` is always the scoped npm name — scope is stripped only at Salesforce boundaries
- `version` is always semver — Salesforce format (`.NEXT`/`.0`) is adapter concern
- `dependencies` uses `{ name: semverConstraint }` records, not Salesforce's `[{package, versionNumber}]` arrays
- `default` lives directly on `PackageDefinition`, not inside `packageOptions`

### Provider Architecture

```
ProjectService (singleton facade)
  └── detects provider via hasWorkspace()
        ├── WorkspaceProvider
        │     ├── reads: package.json files with `sfpm` field
        │     ├── adapter: workspace-adapter.ts (toPackageDefinition / toWorkspacePackageJson)
        │     └── writes: package.json + derived sfdx-project.json
        └── SfdxProjectProvider
              ├── reads: sfdx-project.json via @salesforce/core
              ├── adapter: sfdx-project-adapter.ts (fromSalesforceProjectJson / toSalesforceProjectJson)
              └── writes: sfdx-project.json directly
```

#### ProjectDefinitionProvider Interface

```typescript
interface ProjectDefinitionProvider {
  readonly projectDir: string;
  resolve(): ProjectDefinitionResult;
  resolveForPackage(packageName: string, options?): ProjectDefinition;
  updatePackageConfig(packageName: string, updates: Partial<PackageDefinition>): Promise<void>;
  // Query methods (all delegated to shared standalone functions)
  getAllPackageDefinitions(): PackageDefinition[];
  getAllPackageNames(): string[];
  getPackageDefinition(packageName: string): PackageDefinition;
  getDependencies(packageName: string): PackageDefinition[];
  getPackageType(packageName: string): PackageType;
  // ...
}
```

Both providers delegate query methods to shared pure functions in `project-definition-provider.ts`, passing `this.resolve().definition`. This avoids duplicating lookup logic.

#### Adapters (Bidirectional Converters)

Adapters are pure functions that convert between SFPM canonical types and backing formats:

| Adapter | Read direction | Write direction |
|---------|---------------|-----------------|
| `workspace-adapter.ts` | `WorkspacePackageJson → PackageDefinition` | `PackageDefinition → WorkspacePackageJson` |
| `sfdx-project-adapter.ts` | `sfdx-project.json → ProjectDefinition` | `ProjectDefinition → sfdx-project.json` |

**Key conversions in sfdx-project-adapter:**
- `.name` ↔ `.package` (scope stripped via `stripScope()`)
- `.version` (semver) ↔ `.versionNumber` (4-part SF format with `.NEXT`/`.0`)
- `.dependencies` record ↔ `dependencies[]` array
- `.packageId` + `.managedDependencies` ↔ `packageAliases`

### sfdx-project.json Sync

In workspace mode, `sfdx-project.json` is **derived** — not the source of truth. It's generated so `@salesforce/core`'s `SfProject` can resolve it. The sync process:

1. `ProjectService.create()` calls `WorkspaceProvider.ensureSfdxProject()` on initial resolve
2. `ProjectService.saveProjectDefinition()` re-syncs after updating packages
3. `ProjectService.syncSfdxProject()` can be called explicitly after provider updates

```typescript
// After updating packageIds via provider, re-sync the derived file
await provider.updatePackageConfig(name, { packageId });
projectService.syncSfdxProject(); // regenerates sfdx-project.json
```

### Scope-Aware Lookups

Package names use npm scopes (e.g. `@b64/sfpm-artifact`), but Salesforce knows packages by unscoped names. All internal lookups support both:

```typescript
// ProjectGraph.resolveNode() — tries exact match, falls back to scope-stripped
// getPackageDefinition() — matches by name or stripScope(name)
// resolveForPackage() — same fallback
```

Use `stripScope()` from `utils/scope-utils.ts` at Salesforce boundaries (DevHub Package2 names, sfdx-project.json `package` field, `packageAliases` keys).

### Zod Validation

Both providers validate resolved definitions against `PackageDefinitionSchema` / `ProjectDefinitionSchema`:
- `PackageType` is validated as `z.nativeEnum(PackageType)` (not a loose string)
- Schemas use `.passthrough()` to allow forward-compatible extension
- Validation runs in `resolve()`, not at read time — invalid config fails early

### Write Path

All config updates flow through `provider.updatePackageConfig()`:

```typescript
// PackageCreator persisting a packageId
await provider.updatePackageConfig(config.name, { packageId });

// VersionManager saving bumped versions
await projectService.saveProjectDefinition(updatedDefinition);
// → iterates packages → provider.updatePackageConfig() each → syncSfdxProject()
```

- `WorkspaceProvider.updatePackageConfig()` → writes to `package.json`, invalidates cache
- `SfdxProjectProvider.updatePackageConfig()` → writes to `sfdx-project.json`, maps SFPM field names
- Never write to backing files directly — always go through the provider

## Project Graph

`ProjectGraph` builds a DAG of `PackageNode` entries from the project definition:

```
createLocalNodes() → createManagedNodes() → wireDependencyEdges()
```

- **Local nodes** are built from `ProjectDefinition.packages`
- **Managed nodes** are stub entries created for `managedDependencies` entries with `04t` prefix IDs
- **Edge wiring** resolves both `dependencies` and `managedDependencies` with scope-aware fallback
- Provides: `getInstallationLevels()` (Kahn's algorithm), `getTransitiveDependencies()` (DFS), `detectCircularDependencies()` (color-marking DFS)

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
export class SfpmPackageFactory {
    constructor(private provider: ProjectDefinitionProvider) {}

    public createFromName(packageName: string): SfpmPackage {
        const allPackages = this.provider.getAllPackageDefinitions();
        const definition = allPackages.find(
            p => p.name === packageName || stripScope(p.name) === packageName
        );
        // Create appropriate package type based on definition.type
    }
}
```

## Dependency Injection

Pass dependencies through constructors, not global singletons.

```typescript
// Good: Dependencies injected via provider interface
export class PackageInstaller {
    constructor(
        private provider: ProjectDefinitionProvider,
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
