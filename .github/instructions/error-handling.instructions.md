---
description: Error handling patterns and custom error types for SFPM
applyTo: 'packages/core/src/**/*.ts,packages/cli/src/**/*.ts'
---

## Error Handling Philosophy

Use structured, rich error types that provide context and can be easily formatted for both CLI and JSON output.

**Favor composition over inheritance** - Each error type is independent and uses utility functions for shared behavior rather than inheriting from a base class.

## Custom Error Types

Always use custom error classes from `types/errors.ts` instead of generic `Error`:

### Available Error Types

1. **BuildError** - For build process failures
2. **InstallationError** - For installation failures
3. **StrategyError** - For strategy selection/execution failures
4. **ArtifactError** - For artifact read/write/extract operations
5. **DependencyError** - For dependency resolution issues
6. **NoSourceChangesError** - For successful early exit when no changes detected

### Usage Examples

```typescript
import { BuildError, InstallationError } from '../types/errors.js';

// Build error with step context
throw new BuildError(packageName, 'Assembly failed', {
    buildStep: 'artifact-assembly',
    context: { stagingDir: '/path/to/staging' },
    cause: originalError
});

// Installation error with full context
throw new InstallationError(packageName, targetOrg, 'Version installation failed', {
    packageVersion: '1.0.0-1',
    installationStep: 'version-install',
    installationMode: 'version-install',
    context: { versionId: '04t...' },
    cause: salesforceError
});
```

## Error Handling Patterns

### 1. Wrap External Errors

Always wrap errors from external libraries (Salesforce SDK, fs-extra, etc.) with our custom error types:

```typescript
try {
    await externalOperation();
} catch (error) {
    throw new InstallationError(
        packageName,
        targetOrg,
        'Operation failed',
        { cause: error instanceof Error ? error : new Error(String(error)) }
    );
}
```

### 2. Add Context

Include relevant context that helps debugging:

```typescript
throw new ArtifactError(packageName, 'extract', 'Failed to read metadata', {
    version: '1.0.0-1',
    context: {
        zipPath: '/path/to/artifact.zip',
        entryName: 'artifact_metadata.json'
    },
    cause: error
});
```

### 3. Preserve Error Chains

Use the `cause` parameter to preserve the original error:

```typescript
catch (error) {
    throw new BuildError(packageName, 'Build failed', {
        buildStep: currentStep,
        cause: error instanceof Error ? error : new Error(String(error))
    });
}
```

### 4. Don't Re-wrap Custom Errors

If catching a custom error type (BuildError, InstallationError, etc.), either handle it or re-throw as-is:

```typescript
catch (error) {
    if (error instanceof InstallationError) {
        // Already properly structured - re-throw or handle
        throw error;
    }
    // Wrap non-custom errors
    throw new InstallationError(...);
}
```

### 5. Use Utility Functions

For shared behavior, use the provided utility functions:

```typescript
import { errorToJSON, preserveErrorChain } from '../types/errors.js';

// Preserve error chains
preserveErrorChain(myError, originalError);

// Convert to JSON
const jsonOutput = errorToJSON(myError);
```

## Error Interface

All custom errors implement `DisplayableError` interface:

```typescript
interface DisplayableError {
    toDisplayMessage(): string;
}
```

This ensures consistent formatting without requiring inheritance.

## CLI Error Display

In CLI commands, use `toDisplayMessage()` for user-friendly output:

```typescript
try {
    await installer.install();
} catch (error) {
    if (error && typeof (error as any).toDisplayMessage === 'function') {
        this.error((error as DisplayableError).toDisplayMessage(), { exit: 1 });
    }
    // Handle generic errors
    this.error(error instanceof Error ? error.message : String(error), { exit: 1 });
}
```

## JSON Output

For JSON mode, use `toJSON()` method or `errorToJSON()` utility:

```typescript
import { errorToJSON, DisplayableError } from '@b64/sfpm-core';

if (flags.json) {
    this.logJson({
        success: false,
        error: error && typeof (error as any).toJSON === 'function'
            ? (error as any).toJSON()
            : errorToJSON(error as Error)
    });
}
```

## Logging vs Throwing

- **Throw errors** for unrecoverable failures that should stop execution
- **Log warnings** for recoverable issues or informational messages
- Use logger methods: `error()`, `warn()`, `info()`, `debug()`, `trace()`

```typescript
// Throw for failures
if (!packageVersionId) {
    throw new InstallationError(packageName, targetOrg, 'Package version ID not found');
}

// Log for warnings
if (!metadata) {
    this.logger?.warn(`No metadata found for ${packageName}, using defaults`);
}
```

## Testing Error Handling

Test both error types and messages:

```typescript
it('should throw BuildError with context', async () => {
    await expect(builder.build()).rejects.toThrow(BuildError);
    
    try {
        await builder.build();
    } catch (error) {
        expect(error).toBeInstanceOf(BuildError);
        expect((error as BuildError).packageName).toBe('test-package');
        expect((error as BuildError).buildStep).toBe('assembly');
    }
});
```
