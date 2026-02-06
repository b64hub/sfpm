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

### Version Format Boundaries

**IMPORTANT:** There are two different version number formats used in this project:

1. **Salesforce Format** (used in sfdx-project.json): `major.minor.patch.build`
   - Example: `1.0.0.NEXT`, `1.0.0.1`, `1.0.0.0`
   - Uses **dot** (`.`) as separator for all segments
   - Required by Salesforce CLI and APIs

2. **npm Format** (used in artifacts): `major.minor.patch-build`
   - Example: `1.0.0-1`, `1.0.0-abc123`
   - Uses **hyphen** (`-`) to separate build number
   - Compatible with semantic versioning (semver)
   - Used for npm publishing and artifact storage

**Conversion happens during build process:**
- **Input:** `sfdx-project.json` with Salesforce format (`1.0.0.NEXT` or `1.0.0.0`)
- **Output:** Artifact with npm format (`1.0.0-1` or `1.0.0-123`)

### In sfdx-project.json

Version number format depends on package type:

**Unlocked Packages** - Use `.NEXT` as placeholder for development:

```json
{
  "packageDirectories": [
    {
      "path": "force-app",
      "package": "MyUnlockedPackage",
      "versionNumber": "1.0.0.NEXT",
      "type": "unlocked"
    }
  ]
}
```

**Source Packages** (and other non-unlocked types) - Use `.0` as placeholder:

```json
{
  "packageDirectories": [
    {
      "path": "force-app",
      "package": "MySourcePackage",
      "versionNumber": "1.0.0.0",
      "type": "source"
    }
  ]
}
```

### In Artifacts

Build process converts Salesforce format to npm format:

**Unlocked packages:**
- `1.0.0.NEXT` (Salesforce) → `1.0.0-1` (npm) - first build
- `1.0.0.NEXT` (Salesforce) → `1.0.0-2` (npm) - second build
- Build number comes from Salesforce package creation

**Source packages** (and other types):
- `1.0.0.0` (Salesforce) → `1.0.0-<nonce>` (npm)
- Build identifier can be timestamp, random nonce, or sequential number
- Not tied to Salesforce's build number system
- Example: `1.0.0-abc123`, `1.0.0-1674567890`

### Version Resolution Priority

When loading a package, resolve version in this order:

1. **Artifact metadata** (if artifacts exist) - Shows actual built version
2. **sfdx-project.json** - Shows `.NEXT` (unlocked) or `.0` (source/other) for development

```typescript
// In PackageInstaller
const artifactInfo = artifactService.getLocalArtifactInfo(projectDir, packageName);
if (artifactInfo.version) {
    package.version = artifactInfo.version; // Use artifact version (e.g., "1.0.0-1" or "1.0.0-abc123")
}
// Otherwise uses version from sfdx-project.json (e.g., "1.0.0.NEXT" or "1.0.0.0")
```

### Package Type Specific Handling

**Unlocked Packages:**
- Development version: `1.0.0.NEXT`
- Build version: `1.0.0-<buildNumber>` (Salesforce managed)
- Uses packageVersionId (04t...) for installation

**Source Packages:**
- Development version: `1.0.0.0`
- Build version: `1.0.0-<nonce>` (SFPM managed)
- Always deployed as source, no packageVersionId

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
interface PackageIdentity {
    packageName: string;           // Required
    versionNumber?: string;         // Optional (may be .NEXT)
    version?: string;               // Resolved actual version
    packageVersionId?: string;      // 04t... (unlocked packages only)
}
```

### Setting packageVersionId

Only set when:
1. Artifacts exist locally
2. Artifact metadata can be extracted
3. Package is unlocked type

```typescript
// In PackageInstaller
if (sfpmPackage instanceof SfpmUnlockedPackage && artifactInfo.metadata) {
    const unlockedIdentity = artifactInfo.metadata.identity as any;
    if (unlockedIdentity?.packageVersionId) {
        sfpmPackage.packageVersionId = unlockedIdentity.packageVersionId;
    }
}
```

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
