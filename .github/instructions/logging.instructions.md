---
description: Logging patterns and environment-agnostic logger abstraction
applyTo: 'packages/core/src/**/*.ts,packages/cli/src/**/*.ts,packages/actions/src/**/*.ts,packages/orgs/src/**/*.ts'
---

## Logging Philosophy

SFPM uses an **environment-agnostic Logger interface** defined in `@b64hub/sfpm-core`. All core business logic depends only on this interface — never on a concrete logger implementation. The environment (CLI, GitHub Actions, tests, scripts) provides the appropriate implementation via dependency injection.

**Key principles**:
- The `Logger` interface is **purely diagnostic** — it handles internal messages (info, debug, trace, warn, error) written to stderr
- **Command output** (user-facing results) is a separate concern handled by the CLI layer (oclif's `this.log()` to stdout)
- Core packages never import a concrete logger — they receive one via constructor injection

See [ADR 0001 — Pino logging strategy](../../docs/adr/0001-pino-logging-strategy.md) for the rationale behind these decisions.

## Logger Interface Hierarchy

### Base Interface — `Logger`

The minimal contract all loggers must implement. Defined in `packages/core/src/types/logger.ts`:

```typescript
interface Logger {
    info(message: string): void;   // Key milestones, state changes
    warn(message: string): void;   // Warnings (non-fatal, recoverable)
    error(message: string): void;  // Unrecoverable failures
    debug(message: string): void;  // Debug detail (usually hidden)
    trace(message: string): void;  // Finest-grain tracing
    child?(bindings: Record<string, string>): Logger;  // Scoped child logger
}
```

> **No `log()` method.** The Logger is purely diagnostic. User-facing output (results, summaries) belongs in the CLI/entrypoint layer, not in the Logger interface.

### Child Loggers

The optional `child()` method creates a scoped logger with bound context fields. Every message logged through the child automatically includes the context:

```typescript
// In orchestrators — per-package scoping:
const pkgLogger = this.logger?.child?.({ package: packageName }) ?? this.logger;
pkgLogger?.info('Build complete');
// CLI (pino):    { package: "@b64/my-pkg", msg: "Build complete", level: 30 }
// Actions:      [my-pkg] Build complete
// Console:      [@b64/my-pkg] Build complete
```

All built-in logger implementations support `child()`:
- **CLI (pino)**: creates a pino child logger with bound JSON fields
- **GitHub Actions**: creates a buffered child — output is stored and flushed by the renderer as a collapsible group on package completion
- **Console**: creates a logger with a `[prefix]` prepended to messages

### Extended Interface — `StructuredLogger`

Adds grouping and annotation support for environments that support them (currently GitHub Actions only):

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
import { isStructuredLogger } from '@b64hub/sfpm-core';

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
import { noopLogger, type Logger } from '@b64hub/sfpm-core';

const log = this.logger ?? noopLogger;
log.info('No optional chaining needed');
```

## Environment-Specific Implementations

### CLI (`packages/cli/`)

Uses pino via the `CliLoggerFactory` singleton. The base class `SfpmCommand` creates the logger in `run()` and exposes it as `this.sfpmLogger`:

```typescript
// In SfpmCommand (base class) — already done for you:
this.sfpmLogger = CliLoggerFactory.create({
    level: flags['log-level'],   // from --log-level flag
    pretty: !isJson && !isQuiet, // pretty in interactive, JSON otherwise
});

// In your command's execute():
const orchestrator = new BuildOrchestrator(config, graph, options, this.sfpmLogger);
```

**Output destinations:**
- Pino (diagnostic logs) → **stderr** (level-filtered, never corrupts `--json` output)
- Command output (`this.log()`) → **stdout** (user-facing results, always visible)

**Child loggers** for multi-package context:

```typescript
import { CliLoggerFactory } from '../../logger.js';

const pkgLogger = CliLoggerFactory.child(this.sfpmLogger, { package: packageName });
// Every message from pkgLogger includes { package: "@b64/my-pkg" }
```

**Log level control:**
- `--log-level <trace|debug|info|warn|error>` flag on every command (default: `warn`)
- `SFPM_LOG_LEVEL` env var as fallback
- Default is `warn` because event-driven renderers already provide rich progress UI

### GitHub Actions (`packages/actions/`)

Uses `@actions/core` for native Actions integration:

```typescript
import { createGitHubActionsLogger } from '@b64hub/sfpm-actions';

const logger = createGitHubActionsLogger({ prefix: 'validate-pr' });
```

The `GitHubActionsLogger` implements `StructuredLogger`:
- `info/warn/error/debug` → `core.info/warning/error/debug`
- `group/groupEnd` → `core.startGroup/endGroup` (collapsible log sections)
- `annotate()` → `core.error/warning/notice` with file annotations on PR diffs

### Console / Scripts

Use the built-in factory for simple Node.js scripts:

```typescript
import { createConsoleLogger } from '@b64hub/sfpm-core';

const logger = createConsoleLogger({ level: 'debug' });
```

### Tests

Use a mock logger to verify logging behavior:

```typescript
const mockLogger: Logger = {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
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

### Diagnostic logging vs command output

```typescript
// ✅ Diagnostic logging — goes through Logger to stderr
this.logger?.info(`Building ${packageName} v${version}`);
this.logger?.debug(`Using strategy: ${strategy.constructor.name}`);
this.logger?.warn(`No artifacts found for ${packageName}, deploying from source`);

// ✅ Command output — goes through oclif's this.log() to stdout
this.log(`Installed 3 packages`);
this.log(successBox('Build complete', { packages: built.join(', ') }));

// ❌ Don't log sensitive data
this.logger?.debug(`Auth token: ${token}`);  // Never log tokens

// ❌ Don't use console directly in library code
console.log('Processing...');  // Use logger interface instead

// ❌ Don't couple to a specific environment
import chalk from 'chalk';
this.logger?.info(chalk.green('Done')); // Logger implementations handle formatting

// ❌ Don't construct ad-hoc logger objects in commands
const logger: Logger = { debug: ..., info: ..., ... };  // Use this.sfpmLogger instead
```

## Event Emitters vs Logging

SFPM uses **both** event emitters and logging, each for distinct purposes:

| Concern | Mechanism | Destination | Example |
|---------|-----------|-------------|---------|
| Progress UI | EventEmitter → Renderer | stdout | `emit('deployment:progress', { status })` |
| Diagnostic messages | Logger | stderr | `logger.debug('Resolved artifact v1.0.0-3')` |
| Command results | oclif `this.log()` | stdout | `this.log('Installed 3 packages')` |

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
import type { StructuredLogger } from '@b64hub/sfpm-core';

export class MyEnvLogger implements StructuredLogger {
    info(message: string): void { /* ... */ }
    warn(message: string): void { /* ... */ }
    error(message: string): void { /* ... */ }
    debug(message: string): void { /* ... */ }
    trace(message: string): void { /* ... */ }
    group(label: string): void { /* ... */ }
    groupEnd(): void { /* ... */ }
}

export function createMyEnvLogger(): MyEnvLogger {
    return new MyEnvLogger();
}
```
