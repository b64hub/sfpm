---
description: Logging patterns and environment-agnostic logger abstraction
applyTo: 'packages/core/src/**/*.ts,packages/cli/src/**/*.ts,packages/actions/src/**/*.ts,packages/orgs/src/**/*.ts'
---

## Logging Philosophy

SFPM uses an **environment-agnostic Logger interface** defined in `@b64/sfpm-core`. All core business logic depends only on this interface — never on a concrete logger implementation. The environment (CLI, GitHub Actions, tests, scripts) provides the appropriate implementation via dependency injection.

**Key principle**: Core packages log structured messages. The _environment_ decides _how_ those messages appear.

## Logger Interface Hierarchy

### Base Interface — `Logger`

The minimal contract all loggers must implement. Defined in `packages/core/src/types/logger.ts`:

```typescript
interface Logger {
    log(message: string): void;    // General output (always visible)
    info(message: string): void;   // Informational messages
    warn(message: string): void;   // Warnings (non-fatal)
    error(message: string): void;  // Errors
    debug(message: string): void;  // Debug detail (usually hidden)
    trace(message: string): void;  // Finest-grain tracing
}
```

### Extended Interface — `StructuredLogger`

Adds grouping and annotation support for environments that support them:

```typescript
interface StructuredLogger extends Logger {
    group(label: string): void;
    groupEnd(): void;
    annotate?(level: 'error' | 'notice' | 'warning', message: string, properties?: AnnotationProperties): void;
}
```

### Type Guard

Use `isStructuredLogger()` before calling extended methods:

```typescript
import { isStructuredLogger } from '@b64/sfpm-core';

if (isStructuredLogger(logger)) {
    logger.group('Deployment');
    // ... work ...
    logger.groupEnd();
} else {
    logger.info('--- Deployment ---');
}
```

## Logger Injection Pattern

**Always pass Logger as an optional constructor parameter** (typically last). Store as `private readonly logger?: Logger` and use optional chaining:

```typescript
// Good — optional Logger via DI
export class MyService {
    constructor(
        private readonly config: Config,
        private readonly logger?: Logger,
    ) {}

    doWork(): void {
        this.logger?.info('Starting work...');
    }
}

// Bad — importing a concrete logger
import { cliLogger } from '../cli/logger.js';  // ❌ Couples to environment
```

### When no logger is needed in hot paths

Use the `noopLogger` sentinel to avoid `?.` chains:

```typescript
import { noopLogger, type Logger } from '@b64/sfpm-core';

const log = this.logger ?? noopLogger;
log.info('No optional chaining needed');
```

## Environment-Specific Implementations

### CLI (`packages/cli/`)

Creates a Logger from oclif's Command methods:

```typescript
const logger: Logger = {
    debug: (msg) => this.debug(msg),
    error: (msg) => this.error(msg),
    info: (msg) => this.debug(msg),
    log: (msg) => this.log(msg),
    trace: (msg) => this.debug(msg),
    warn: (msg) => this.warn(msg),
};
```

### GitHub Actions (`packages/actions/`)

Uses `@actions/core` for native Actions integration:

```typescript
import { createGitHubActionsLogger } from '@b64/sfpm-actions';

const logger = createGitHubActionsLogger({ prefix: 'validate-pr' });
```

The `GitHubActionsLogger` implements `StructuredLogger`:
- `info/warn/error/debug` → `core.info/warning/error/debug`
- `group/groupEnd` → `core.startGroup/endGroup` (collapsible log sections)
- `annotate()` → `core.error/warning/notice` with file annotations on PR diffs

### Console / Scripts

Use the built-in factory for simple Node.js scripts:

```typescript
import { createConsoleLogger } from '@b64/sfpm-core';

const logger = createConsoleLogger({ level: 'debug' });
```

### Tests

Use a mock logger to verify logging behavior:

```typescript
const mockLogger: Logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    log: vi.fn(),
    trace: vi.fn(),
    warn: vi.fn(),
};

const service = new MyService(config, mockLogger);
await service.doWork();

expect(mockLogger.info).toHaveBeenCalledWith('Starting work...');
```

## Log Level Guidelines

| Level | When to use | Examples |
|-------|-------------|---------|
| `error` | Unrecoverable failures | `"Deployment failed: INVALID_FIELD"` |
| `warn` | Recoverable issues, degraded behavior | `"No metadata found, using defaults"` |
| `info` | Key milestones, state changes | `"Package built: v1.0.0-3"`, `"Org claimed"` |
| `debug` | Internal detail useful for debugging | `"Strategy selected: SourceDeployStrategy"` |
| `trace` | Very fine-grained, noisy detail | `"SOQL query: SELECT Id FROM ..."` |
| `log` | General output that is always visible | `"Installed 3 packages"` |

### Do's and Don'ts

```typescript
// ✅ Log at appropriate levels
this.logger?.info(`Building ${packageName} v${version}`);
this.logger?.debug(`Using strategy: ${strategy.constructor.name}`);
this.logger?.warn(`No artifacts found for ${packageName}, deploying from source`);

// ✅ Include context in messages
this.logger?.error(`Failed to connect to ${targetOrg}: ${error.message}`);

// ❌ Don't log sensitive data
this.logger?.debug(`Auth token: ${token}`);  // Never log tokens

// ❌ Don't use console directly in library code
console.log('Processing...');  // Use logger interface instead

// ❌ Don't couple to a specific environment
import chalk from 'chalk';
this.logger?.info(chalk.green('Done')); // Logger implementations handle formatting
```

## Event Emitters vs Logging

SFPM uses **both** event emitters and logging, each for distinct purposes:

| Concern | Mechanism | Example |
|---------|-----------|---------|
| Progress UI | EventEmitter → Renderer | `emit('deployment:progress', { status })` |
| Diagnostic messages | Logger | `logger.debug('Resolved artifact v1.0.0-3')` |

**Events drive rendering** (spinners, log groups, JSON collection).
**Logger handles diagnostic detail** (debugging, tracing, warnings).

In practice, renderers subscribe to events from core services and use their own logger for environment-appropriate output. Core services use their injected logger for supplementary diagnostics.

## Adding a New Logger Implementation

1. Implement `Logger` (or `StructuredLogger` if the environment supports grouping)
2. Create a factory function: `createMyEnvironmentLogger(options)`
3. Export from the environment package
4. Inject into core services via constructor

```typescript
// packages/my-env/src/logger.ts
import type { StructuredLogger } from '@b64/sfpm-core';

export class MyEnvLogger implements StructuredLogger {
    log(message: string): void { /* ... */ }
    info(message: string): void { /* ... */ }
    // ... all other methods
    group(label: string): void { /* ... */ }
    groupEnd(): void { /* ... */ }
}

export function createMyEnvLogger(): MyEnvLogger {
    return new MyEnvLogger();
}
```
