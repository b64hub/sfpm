# Package Installer Architecture

## Overview

The package installer system follows a strategy pattern with a registry-based approach, mirroring the design of the package builder system. It supports installing both Unlocked and Source packages from various source types.

## Architecture Components

### 1. Installation Source Types

```typescript
enum InstallationSourceType {
    LocalSource = 'local',      // From local source folders
    BuiltArtifact = 'artifact', // From built artifacts directory
    RemoteNpm = 'npm'           // From NPM registry
}
```

### 2. Installation Modes

```typescript
enum InstallationMode {
    SourceDeploy = 'source-deploy',     // Deploy metadata using MDAPIdeploy
    VersionInstall = 'version-install'   // Install using package version ID
}
```

## Installation Decision Matrix

| Source Type | Unlocked Package | Source Package |
|------------|------------------|----------------|
| Local Source | Source Deployment | Source Deployment |
| Built Artifact | Version Install OR Source Deploy | Source Deployment |
| Remote NPM | Version Install OR Source Deploy | Source Deployment |

## Components

### Registry System

**`InstallerRegistry`**: Central registry that maps package types to their installer implementations using decorator pattern.

```typescript
@RegisterInstaller(PackageType.Unlocked)
export default class UnlockedPackageInstaller implements Installer { }
```

### Package Type Installers

1. **`UnlockedPackageInstaller`**: Handles unlocked package installations
   - Contains a collection of installation strategies
   - Selects appropriate strategy based on source type and package metadata
   - Manages pre/post-install tasks

2. **`SourcePackageInstaller`**: Handles source package installations
   - Always uses source deployment strategy
   - Simpler than unlocked installer as it has only one strategy

### Installation Strategies

Strategies implement the `InstallationStrategy` interface and directly perform the installation:

1. **`SourceDeployStrategy`** (Unified)
   - **When**: 
     - Any source type + Source package
     - Local source folder + Unlocked package
   - **Mode**: Source Deployment
   - **Action**: Deploy source directly to target org using ComponentSet and MDAPIdeploy

2. **`UnlockedVersionInstallStrategy`**
   - **When**: Built artifact or NPM + Unlocked package with version ID available
   - **Mode**: Version Installation
   - **Action**: Install using Tooling API PackageInstallRequest with polling

### Installation Tasks

Tasks are **auxiliary operations** that happen before or after the core installation. They are NOT the installation itself. Examples include:

- Activating flows
- Running pre-install scripts
- Running post-install scripts
- Assigning permission sets
- Data seeding
- Org configuration

The core installation operations (source deployment and version installation) are performed directly by the strategies, not wrapped as tasks.

## Usage Example

```typescript
import { PackageInstaller, ProjectConfig } from '@b64/sfpm-core';

const projectConfig = await ProjectConfig.load('/path/to/project');

const installer = new PackageInstaller(
    projectConfig,
    {
        targetOrg: 'myOrg',
        installationKey: 'optional-key',
        sourceType: InstallationSourceType.BuiltArtifact
    },
    logger
);

await installer.installPackage('my-package');
```

## Orchestrator

**`PackageInstaller`**: Main orchestrator class
- Uses `PackageFactory` to create package instances
- Retrieves appropriate installer from registry
- Emits install lifecycle events
- Handles errors and logging

## Events

The installer emits events throughout the installation process:
- `install:start`: Installation begins
- `install:complete`: Installation succeeds
- `install:error`: Installation fails

## Design Principles

1. **Composition Over Inheritance**: Removed abstract base classes in favor of interfaces and composition
2. **Strategy Pattern**: Installation strategies are selected at runtime based on package type and source
3. **Registry Pattern**: Installers self-register using decorators
4. **Task-Based**: Installation steps are broken into composable tasks
5. **Type Safety**: Strong TypeScript typing throughout

## Extension Points

To add support for new package types:

1. Create installer class implementing `Installer` interface
2. Decorate with `@RegisterInstaller(PackageType.YourType)`
3. Create installation strategies implementing `InstallationStrategy`
4. Import in `index.ts` to trigger registration
