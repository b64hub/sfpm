---
description: Artifact and package version management patterns
applyTo: 'packages/core/src/**/*.ts'
---

## Artifact Structure

Artifacts are stored in a versioned directory structure:

```
artifacts/
  <package-name>/
    manifest.json              # Version index and metadata
    latest -> 1.0.0-1/         # Symlink to latest version
    1.0.0-1/
      artifact.zip             # Contains source + metadata + changelog
    1.0.0-2/
      artifact.zip
```

### Manifest Format

```json
{
  "name": "package-name",
  "latest": "1.0.0-2",
  "versions": {
    "1.0.0-1": {
      "path": "package-name/1.0.0-1/artifact.zip",
      "sourceHash": "abc123...",
      "artifactHash": "def456...",
      "generatedAt": 1234567890,
      "commit": "git-sha"
    },
    "1.0.0-2": { /* ... */ }
  }
}
```

### Artifact Zip Contents

Inside `artifact.zip`:
- **Source code** - All package source files
- **artifact_metadata.json** - Package metadata including packageVersionId
- **changelog.json** - Change history
- **sfdx-project.json** - In manifests/ subdirectory

## Version Number Patterns

### Canonical Format: Semver

`PackageDefinition.version` is **always semver** (e.g. `1.2.0`). This is the version stored in:
- Workspace `package.json` files (source of truth in workspace mode)
- `PackageDefinition.version` throughout the codebase
- Artifact metadata and npm packages

### Salesforce Format (Adapter Concern)

Salesforce APIs require a 4-part version: `major.minor.patch.build`. The conversion between semver and Salesforce format is handled exclusively by the `sfdx-project-adapter`:

| SFPM (semver) | SF Format (write) | SF Format (read) |
|---------------|-------------------|-------------------|
| `1.0.0` | `1.0.0.NEXT` (unlocked) / `1.0.0.0` (source/data) | `1.0.0.NEXT` → `1.0.0` |
| `1.0.0-5` | `1.0.0.5` | `1.0.0.5` → `1.0.0-5` |

**Key rule:** The `VersionManager` works purely in semver space. It never sees `.NEXT` or `.LATEST`. The adapter handles SF conversion only when writing `sfdx-project.json`.

```typescript
// version-utils.ts entry point
toSalesforceVersionWithToken(version: string, packageType): string
// "1.0.0" + unlocked → "1.0.0.NEXT"
// "1.0.0" + source   → "1.0.0.0"

stripBuildSegment(version: string): string
// "1.0.0.NEXT" → "1.0.0"
// "1.0.0-7"    → "1.0.0"
```

### In Artifacts

Build process assigns concrete build numbers:

- **Unlocked packages:** `1.0.0` → `1.0.0-<buildNumber>` (Salesforce-assigned)
- **Source/data packages:** `1.0.0` → `1.0.0-<nonce>` (SFPM-assigned, timestamp or sequential)

### Version Resolution Priority

1. **Artifact metadata** (if artifacts exist) — shows actual built version with build number
2. **PackageDefinition.version** — base semver without build number

## Reading Artifact Metadata

### Metadata Location

`artifact_metadata.json` is **inside** `artifact.zip` for npm publishing compatibility.

### Reading Pattern

Use **adm-zip** for synchronous extraction:

```typescript
import AdmZip from 'adm-zip';

public getLocalArtifactMetadata(
    projectDirectory: string,
    packageName: string,
    version?: string
): SfpmPackageMetadata | undefined {
    try {
        const manifest = this.getLocalArtifactManifest(projectDirectory, packageName);
        const targetVersion = version || manifest.latest;
        
        const zipPath = path.join(
            this.getLocalArtifactPath(projectDirectory, packageName),
            targetVersion,
            'artifact.zip'
        );

        const zip = new AdmZip(zipPath);
        const metadataEntry = zip.getEntry('artifact_metadata.json');
        
        if (!metadataEntry) {
            return undefined;
        }

        const metadataContent = zip.readAsText(metadataEntry);
        return JSON.parse(metadataContent);
    } catch (error) {
        this.logger?.warn(`Failed to read artifact metadata: ${error.message}`);
        return undefined;
    }
}
```

### Why adm-zip?

- ✅ Synchronous API (simpler to use)
- ✅ Loads small files efficiently
- ✅ Both read and write support
- ✅ Works with archiver (which creates the zips)

Use **archiver** for creating zips (handles symlinks, deterministic timestamps).

## Package Identity

### Core Identity Properties

```typescript
// From PackageDefinition (canonical source)
interface PackageIdentity {
    name: string;              // Scoped npm name: "@b64/sfpm-artifact"
    version: string;           // Semver: "1.2.0"
    packageId?: string;        // Package2 ID: "0Ho..." (unlocked only)
    packageVersionId?: string; // Subscriber version: "04t..." (set during build)
}
```

The `packageVersionId` (04t) is a **build artifact** — it's set by the Salesforce package version creation process and stored in artifact metadata. It is NOT stored in `PackageDefinition` or `package.json`.

### Name Conventions

| Context | Format | Example |
|---------|--------|---------|
| `PackageDefinition.name` | Scoped npm | `@b64/sfpm-artifact` |
| DevHub Package2 name | Unscoped | `sfpm-artifact` |
| sfdx-project.json `package` | Unscoped | `sfpm-artifact` |
| npm artifact package | Scoped | `@b64/sfpm-artifact` |

Use `stripScope()` at Salesforce boundaries. Never strip scope internally.

## Installation Source Type Detection

### Source Types

```typescript
enum InstallationSourceType {
    LocalSource = 'local',      // Install from project source
    BuiltArtifact = 'artifact', // Install from local artifact
    RemoteNpm = 'npm'           // Install from npm registry (future)
}
```

### Auto-Detection Logic

```typescript
private determineSourceType(options?: InstallerOptions): InstallationSourceType {
    // 1. Explicit override
    if (options?.sourceType) {
        return options.sourceType;
    }

    // 2. Check for local artifacts
    if (this.artifactService.hasLocalArtifacts(projectDir, packageName)) {
        return InstallationSourceType.BuiltArtifact;
    }

    // 3. Default to source
    return InstallationSourceType.LocalSource;
}
```

## Installation Strategies

### Strategy Selection by Source Type

| Source Type | Package Type | Has VersionId | Strategy |
|------------|--------------|---------------|----------|
| LocalSource | Unlocked | No | SourceDeployStrategy |
| LocalSource | Source | N/A | SourceDeployStrategy |
| BuiltArtifact | Unlocked | Yes | UnlockedVersionStrategy |
| BuiltArtifact | Unlocked | No | SourceDeployStrategy (fallback) |
| RemoteNpm | Unlocked | Yes | UnlockedVersionStrategy |

### Strategy canHandle() Logic

```typescript
// UnlockedVersionStrategy
public canHandle(sourceType: InstallationSourceType, pkg: SfpmPackage): boolean {
    if (!(pkg instanceof SfpmUnlockedPackage)) {
        return false;
    }

    const hasVersionId = !!pkg.packageVersionId;
    const isValidSourceType = 
        sourceType === InstallationSourceType.BuiltArtifact || 
        sourceType === InstallationSourceType.RemoteNpm;

    return hasVersionId && isValidSourceType;
}

// SourceDeployStrategy
public canHandle(sourceType: InstallationSourceType, pkg: SfpmPackage): boolean {
    // Source packages always use source deployment
    if (pkg instanceof SfpmSourcePackage) {
        return true;
    }

    // Unlocked packages use source deployment for local source
    if (pkg instanceof SfpmUnlockedPackage && 
        sourceType === InstallationSourceType.LocalSource) {
        return true;
    }

    return false;
}
```

## Build Process Flow

1. **Calculate source hash** - Hash all source files
2. **Check for changes** - Compare with last build
3. **Create staging directory** - Assemble package
4. **Generate metadata** - Call `toPackageMetadata()`
5. **Create artifact zip** - Using archiver (with metadata inside)
6. **Calculate artifact hash** - Hash the zip file
7. **Update manifest** - Add version entry with both hashes
8. **Update latest symlink** - Point to new version
9. **Cleanup staging** - Remove temporary files

## Hash-Based Build Skipping

### Source Hash

Hash of all source files (respects .forceignore):

```typescript
private async calculateSourceHash(): Promise<string> {
    const hasher = new SourceHasher(this.sfpmPackage.packageDirectory);
    return await hasher.calculateHash();
}
```

### Artifact Hash

SHA-256 hash of the final artifact.zip:

```typescript
private async calculateFileHash(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);
        stream.on('data', (data) => hash.update(data));
        stream.on('end', () => resolve(hash.digest('hex')));
        stream.on('error', reject);
    });
}
```

### Build Skip Logic

```typescript
const currentHash = await calculateSourceHash();
const lastVersion = manifest.versions[manifest.latest];

if (lastVersion && lastVersion.sourceHash === currentHash) {
    throw new NoSourceChangesError({
        latestVersion: manifest.latest,
        sourceHash: currentHash,
        artifactPath: lastVersion.path
    });
}
```

## Packaging for npm

Artifacts are designed to be published to npm registries:

1. **Metadata stays in zip** - No extraction needed
2. **manifest.json alongside** - For version lookup
3. **Package structure** - Follows npm conventions

```json
{
  "name": "@scope/package-name",
  "version": "1.0.0-1",
  "files": [
    "artifacts/**"
  ]
}
```

## Future: Remote Artifact Fetching

Structure supports future enhancements:

```typescript
// Future: Fetch from npm registry
public async fetchFromNpm(
    packageName: string,
    version?: string
): Promise<ArtifactInfo> {
    // Download package from npm
    // Extract artifacts/
    // Return artifact info
}
```

Keep this in mind when designing artifact-related features.
