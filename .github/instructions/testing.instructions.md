---
description: Testing patterns and best practices for SFPM
applyTo: 'packages/core/test/**/*.ts,packages/cli/test/**/*.ts'
---

## Test File Organization

- Test files mirror source structure: `src/package/package-installer.ts` → `test/package/package-installer.test.ts`
- Use descriptive test file names ending in `.test.ts`
- Group related tests in the same file

## Test Structure

### Standard Test Template

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { YourClass } from '../src/path/to/your-class.js';

// Mock external dependencies at top
vi.mock('fs-extra');
vi.mock('@salesforce/core');

describe('YourClass', () => {
    let instance: YourClass;
    let mockDependency: any;

    beforeEach(() => {
        // Reset mocks
        vi.clearAllMocks();
        
        // Setup mock dependencies
        mockDependency = {
            method: vi.fn()
        };
        
        // Create instance
        instance = new YourClass(mockDependency);
    });

    afterEach(() => {
        // Cleanup if needed
    });

    describe('methodName', () => {
        it('should do something specific', () => {
            // Arrange
            const input = 'test-input';
            
            // Act
            const result = instance.methodName(input);
            
            // Assert
            expect(result).toBe('expected-output');
            expect(mockDependency.method).toHaveBeenCalledWith(input);
        });

        it('should handle error cases', () => {
            // Arrange
            mockDependency.method.mockRejectedValue(new Error('Test error'));
            
            // Act & Assert
            expect(() => instance.methodName('input')).rejects.toThrow('Test error');
        });
    });
});
```

## Mocking Patterns

### Mocking External Modules

```typescript
// Mock entire module
vi.mock('fs-extra', () => ({
    readJson: vi.fn(),
    writeJson: vi.fn(),
    existsSync: vi.fn(),
    ensureDir: vi.fn()
}));

// Access mocked functions
import * as fs from 'fs-extra';
vi.mocked(fs.readJson).mockResolvedValue({ data: 'test' });
```

### Mocking Classes

```typescript
vi.mock('@salesforce/core', () => ({
    Org: {
        create: vi.fn(() => ({
            getConnection: vi.fn(() => ({
                query: vi.fn(),
                tooling: {
                    create: vi.fn()
                }
            }))
        }))
    }
}));
```

### Mocking Event Emitters

```typescript
it('should emit events in correct order', async () => {
    const events: string[] = [];
    
    installer.on('install:start', () => events.push('start'));
    installer.on('install:complete', () => events.push('complete'));
    
    await installer.install();
    
    expect(events).toEqual(['start', 'complete']);
});
```

## Testing Async Code

### Always await or return promises

```typescript
// Good - using async/await
it('should complete installation', async () => {
    await installer.install();
    expect(mockLogger.info).toHaveBeenCalled();
});

// Good - returning promise
it('should complete installation', () => {
    return installer.install().then(() => {
        expect(mockLogger.info).toHaveBeenCalled();
    });
});

// Bad - forgetting await
it('should complete installation', () => {
    installer.install(); // ❌ Test will pass even if it fails
    expect(mockLogger.info).toHaveBeenCalled();
});
```

### Testing Error Cases

```typescript
it('should throw InstallationError on failure', async () => {
    mockConnection.tooling.create.mockRejectedValue(new Error('API Error'));
    
    await expect(installer.install()).rejects.toThrow(InstallationError);
});

it('should include error context', async () => {
    try {
        await installer.install();
        fail('Should have thrown error');
    } catch (error) {
        expect(error).toBeInstanceOf(InstallationError);
        expect((error as InstallationError).packageName).toBe('test-pkg');
        expect((error as InstallationError).targetOrg).toBe('test-org');
    }
});
```

## Testing Strategy Pattern

```typescript
describe('Strategy Selection', () => {
    it('should select UnlockedVersionStrategy for artifacts with versionId', () => {
        const package = new SfpmUnlockedPackage(config);
        package.packageVersionId = '04t...';
        
        const strategy = installer.selectStrategy(
            InstallationSourceType.BuiltArtifact,
            package
        );
        
        expect(strategy).toBeInstanceOf(UnlockedVersionStrategy);
    });

    it('should select SourceDeployStrategy when no versionId', () => {
        const package = new SfpmUnlockedPackage(config);
        // No packageVersionId set
        
        const strategy = installer.selectStrategy(
            InstallationSourceType.LocalSource,
            package
        );
        
        expect(strategy).toBeInstanceOf(SourceDeployStrategy);
    });

    it('should throw StrategyError when no strategy matches', () => {
        expect(() => {
            installer.selectStrategy(
                InstallationSourceType.RemoteNpm,
                invalidPackage
            );
        }).toThrow(StrategyError);
    });
});
```

## Test Data Patterns

### Use Factories for Test Objects

```typescript
function createMockPackage(overrides?: Partial<PackageConfig>): SfpmUnlockedPackage {
    const defaultConfig: PackageConfig = {
        name: 'test-package',
        type: PackageType.Unlocked,
        path: 'force-app',
        versionNumber: '1.0.0.NEXT',
        // ... other defaults
    };
    
    return new SfpmUnlockedPackage(
        { ...defaultConfig, ...overrides },
        mockProjectConfig
    );
}

// Usage
it('should handle different package versions', () => {
    const package1 = createMockPackage({ versionNumber: '1.0.0.1' });
    const package2 = createMockPackage({ versionNumber: '2.0.0.1' });
    // ...
});
```

### Fixture Files

For complex test data, use fixture files:

```typescript
import testManifest from './fixtures/manifest.json';
import testMetadata from './fixtures/artifact-metadata.json';

it('should parse manifest correctly', () => {
    const manifest = ArtifactService.parseManifest(testManifest);
    expect(manifest.versions).toHaveProperty('1.0.0-1');
});
```

## Assertion Patterns

### Use Specific Matchers

```typescript
// Good - specific
expect(result).toBe(true);
expect(array).toHaveLength(3);
expect(object).toHaveProperty('name', 'test');
expect(string).toContain('error');

// Avoid - too generic
expect(result).toBeTruthy(); // Could be any truthy value
expect(array.length).toBe(3); // Less semantic
```

### Testing Complex Objects

```typescript
// Partial matching
expect(result).toEqual(expect.objectContaining({
    packageName: 'test-package',
    version: expect.any(String),
    timestamp: expect.any(Date)
}));

// Array contents
expect(array).toEqual(expect.arrayContaining([
    'item1',
    'item2'
]));
```

## Coverage Guidelines

### Aim for High Coverage in Core Logic

- **Critical paths**: 90%+ coverage for installers, builders, assemblers
- **Strategies**: Test all `canHandle()` conditions
- **Error paths**: Test both success and failure scenarios
- **Utilities**: 80%+ coverage for utility functions

### What to Test

✅ **Test**:
- Business logic
- Error handling
- Edge cases
- Integration between components
- Public API contracts

❌ **Don't test**:
- Trivial getters/setters
- External library internals
- TypeScript type definitions

## Integration Tests

For tests that involve multiple components:

```typescript
describe('PackageInstaller Integration', () => {
    let installer: PackageInstaller;
    let projectConfig: ProjectConfig;
    
    beforeEach(async () => {
        // Setup real-ish environment
        projectConfig = await ProjectConfig.load('/test/project');
        installer = new PackageInstaller(projectConfig, options);
    });

    it('should install package end-to-end', async () => {
        // Test full workflow
        await installer.installPackage('test-package');
        
        // Verify side effects
        expect(mockOrg.getConnection).toHaveBeenCalled();
        expect(mockConnection.tooling.create).toHaveBeenCalledWith(
            'PackageInstallRequest',
            expect.any(Object)
        );
    });
});
```

## Test Performance

### Keep Tests Fast

- Mock slow operations (file I/O, network calls)
- Use in-memory test doubles instead of real files
- Parallelize independent tests
- Avoid unnecessary `beforeEach` setup

```typescript
// Slow - creates files
beforeEach(async () => {
    await fs.writeJson('/tmp/test.json', data);
});

// Fast - uses mock
beforeEach(() => {
    vi.mocked(fs.readJson).mockResolvedValue(data);
});
```

## Test Naming

Use descriptive test names that explain intent:

```typescript
// Good
it('should throw InstallationError when packageVersionId is missing')
it('should emit deployment:progress event with percentage')
it('should select SourceDeployStrategy for local source packages')

// Bad
it('works')
it('should handle error')
it('test installation')
```

## Running Tests

```bash
# Run all tests
pnpm test

# Run specific test file
pnpm test package-installer.test.ts

# Run tests in watch mode
pnpm test --watch

# Run with coverage
pnpm test --coverage
```
