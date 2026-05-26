# Pino-backed logging with diagnostic-only Logger interface

Core packages (core, orgs, hooks, sfdmu) depend on an environment-agnostic `Logger` interface with five diagnostic levels: `info`, `debug`, `trace`, `warn`, `error`. Entrypoints (CLI, Actions) provide concrete implementations. The CLI uses pino, writing to stderr, with `pino-pretty` in interactive mode and JSON in CI modes. The `log()` method was removed from the interface because it conflated diagnostic logging (what happened internally) with command output (results for the user) — those are separate concerns. Command output goes through oclif's `this.log()` to stdout; diagnostic messages go through the injected `Logger` to stderr.

## Considered Options

- **Keep `log()` on Logger** — convenient, but muddied the boundary between "diagnostic message" and "user-facing result." Every logger implementation had to decide what `log()` means, and they all did it differently.
- **Global singleton logger everywhere** — less boilerplate, but couples core to an import and makes testing harder (global state to reset). Hybrid approach: singleton in CLI, DI into core.
- **`info` as default level** — rejected because the event-driven renderers already provide rich user feedback. `warn` as default keeps the terminal clean; developers opt into verbosity with `--log-level debug`.
