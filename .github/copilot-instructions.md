# SFPM Developer Instructions

This directory contains AI-agent and developer instructions for working with the SFPM codebase. These files help maintain consistency and communicate architectural patterns.

## Instruction Files

### [command.instructions.md](./instructions/command.instructions.md)
Output style and JSON support for CLI commands
- No emojis in output
- Use ora, chalk, and boxen for UI
- JSON mode for all central commands

### [error-handling.instructions.md](./instructions/error-handling.instructions.md)
Error handling patterns and custom error types
- Use rich error types: `BuildError`, `InstallationError`, `StrategyError`, `ArtifactError`, `DependencyError`
- Always wrap external errors
- Preserve error chains with `cause`
- Use `toDisplayMessage()` for CLI, `toJSON()` for API

### [architecture.instructions.md](./instructions/architecture.instructions.md)
Core architecture patterns and best practices
- Package structure and organization
- Strategy pattern for flexible behavior
- Event emitter pattern for progress tracking
- Service layer for external systems
- Factory pattern for object creation
- Dependency injection over globals

### [testing.instructions.md](./instructions/testing.instructions.md)
Testing patterns and best practices
- Test structure with vitest
- Mocking external dependencies
- Testing async code and strategies
- Test data factories and fixtures
- Coverage guidelines
- Integration test patterns

### [artifacts.instructions.md](./instructions/artifacts.instructions.md)
Artifact and package version management
- Artifact directory structure
- Version number patterns (`.NEXT` → `1.0.0-1`)
- Reading metadata from zip files
- Installation source type detection
- Build process and hash-based skipping
- npm packaging considerations

### [logging.instructions.md](./instructions/logging.instructions.md)
Logging patterns and environment-agnostic logger abstraction
- `Logger` interface (base) and `StructuredLogger` (extended with groups/annotations)
- Logger injection via optional constructor parameter
- Environment-specific implementations: CLI, GitHub Actions, console, tests
- `noopLogger` sentinel, `createConsoleLogger()` factory, `isStructuredLogger()` type guard
- Log level guidelines (error/warn/info/debug/trace)
- Events vs logging separation of concerns

### [actions.instructions.md](./instructions/actions.instructions.md)
GitHub Actions integration patterns
- PR validation pipeline (org cache → pool fetch → deploy)
- Scratch org caching with TTL per PR
- `GitHubActionsLogger` integrating with `@actions/core`
- `ActionsProgressRenderer` for event-driven log output
- Action inputs/outputs and workflow usage
- Bundling with esbuild for single-file distribution

## How These Are Used

### By AI Agents
The `.instructions.md` files are automatically discovered and used by GitHub Copilot and other AI coding assistants to provide context-aware suggestions.

### By Developers
Read these files to understand:
- Established patterns in the codebase
- Why certain approaches were chosen
- How to extend or modify existing functionality
- Testing and error handling expectations

## Updating Instructions

When adding new patterns or making architectural decisions:

1. Update the relevant instruction file
2. Include examples of both good and bad patterns
3. Explain the "why" behind the pattern
4. Update this README if adding new instruction files

## Pattern Overview

### Core Principles

**Separation of Concerns**
- **Core** (`packages/core/`) - Business logic, no CLI or environment concerns
- **CLI** (`packages/cli/`) - User interface, command handling, spinner/box rendering
- **Actions** (`packages/actions/`) - GitHub Actions integration, action.yml definitions
- **Orgs** (`packages/orgs/`) - Scratch org pool management, DevHub operations

**Logging**
- Environment-agnostic `Logger` interface in core
- `StructuredLogger` extension for groups and annotations
- CLI, GitHub Actions, and console implementations
- Injected via constructor, never imported globally

**Error Handling**
- Rich, structured error types with context
- Error chains preserved with `cause`
- Display formatting separated from error creation

**Extensibility**
- Strategy pattern for behavior variants
- Event emitters for progress and integration
- Registry pattern for plugin-like extensions

**Testing**
- High coverage for core business logic
- Mock external dependencies
- Test both success and error paths

**Type Safety**
- Strong typing throughout
- No `any` except at external boundaries
- Interfaces for extensibility

## Quick Reference

### Adding a New Installation Strategy

1. Implement `InstallationStrategy` interface
2. Define `canHandle()` conditions
3. Register in installer's strategy array
4. Add tests for `canHandle()` logic
5. Update [artifacts.instructions.md](./instructions/artifacts.instructions.md) strategy table

### Adding a New Error Type

1. Extend native `Error` base class
2. Implement `toDisplayMessage()`
3. Add context fields as needed
4. Export from `types/errors.ts`
5. Document in [error-handling.instructions.md](./instructions/error-handling.instructions.md)

### Adding a New CLI Command

1. Use `oclif generate command <name>`
2. Add flags following command.instructions.md
3. Implement with core services
4. Add progress rendering if long-running
5. Support `--json` flag
6. Handle errors with rich error types
7. Add tests

### Adding a New Build Task

1. Implement `BuildTask` interface
2. Add to builder's task array in order
3. Throw `BuildError` on failure
4. Log progress with logger
5. Test with mocked dependencies

### Adding a New GitHub Action

1. Create `src/my-action.ts` with pipeline logic
2. Create `src/my-action-main.ts` entry point
3. Add/update `action.yml` definition
4. Wire inputs → options → core services
5. Use `GitHubActionsLogger` for logging
6. Use `ActionsProgressRenderer` for event-driven output
7. Add tests with mocked `@actions/*` dependencies
8. Update [actions.instructions.md](./instructions/actions.instructions.md)

## Contributing

When contributing to SFPM:

1. **Read relevant instruction files** before starting
2. **Follow established patterns** for consistency
3. **Add tests** for new functionality
4. **Update instructions** if introducing new patterns
5. **Use rich error types** for all failures

## Questions?

If patterns are unclear or missing:
1. Check if similar functionality exists elsewhere
2. Review the instruction files
3. Ask in PR review
4. Propose pattern updates via PR to these instruction files
