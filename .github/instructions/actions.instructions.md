---
description: GitHub Actions patterns for SFPM — PR validation, scratch org caching, and CI/CD integration
applyTo: 'packages/actions/src/**/*.ts'
---

## Package Overview

`@b64hub/sfpm-actions` provides GitHub Action wrappers around core SFPM functionality. It is a thin integration layer — all business logic lives in `@b64hub/sfpm-core` and `@b64hub/sfpm-orgs`.

### Package Structure

```
packages/actions/
  validate-pr/action.yml  # node24 action definition for validate-pr
  bundle/                 # Committed, release-built esbuild bundle: 8 per-action entries + shared chunks + shims
  src/
    validate-main.ts     # Action entry point (reads inputs, runs validatePr)
    index.ts              # Library exports
    logger.ts             # GitHubActionsLogger implementing StructuredLogger
    org-cache.ts          # OrgCacheService for PR-scoped scratch org caching
    progress-renderer.ts  # ActionsProgressRenderer for event-driven log output
    validate-pr.ts        # Main PR validation pipeline
  test/
    logger.test.ts
    org-cache.test.ts
    progress-renderer.test.ts
```

## Architecture

### Separation of Concerns

```
┌─────────────┐     ┌──────────────┐     ┌─────────────────────┐
│  action.yml  │ ──> │validate-main.ts│ ──> │   validate-pr.ts    │
│  (inputs)    │     │  (wiring)    │     │  (pipeline)         │
└─────────────┘     └──────────────┘     └─────────────────────┘
                                              │
                         ┌────────────────────┼────────────────────┐
                         ▼                    ▼                    ▼
                   ┌──────────┐       ┌──────────────┐     ┌────────────┐
                   │ OrgCache │       │ PoolFetcher  │     │ Install    │
                   │ Service  │       │ (from orgs)  │     │ Orchestr.  │
                   └──────────┘       └──────────────┘     │ (from core)│
                                                           └────────────┘
```

- **`validate-main.ts`** — reads `@actions/core` inputs, calls `validatePr()`, sets outputs
- **`validate-pr.ts`** — orchestrates the full pipeline (org resolution → deployment)
- **`org-cache.ts`** — manages `@actions/cache` for PR-scoped scratch org reuse
- **`logger.ts`** — `GitHubActionsLogger` with buffered child registry (see below)
- **`progress-renderer.ts`** — buffered event-driven renderer that flushes per-package groups atomically

### Logging and Rendering

The actions package uses `GitHubActionsLogger` which implements `StructuredLogger` and adds buffered child logger support:

```typescript
const logger = createGitHubActionsLogger({ prefix: 'validate-pr' });
const renderer = new ActionsProgressRenderer(logger);
const orchestrator = new BuildOrchestrator(..., logger); // same instance
```

**Dual behavior by depth:**
- **Top-level** (`logger.info(...)`) — writes immediately via `core.info()`
- **Child loggers** (`logger.child({package: 'foo'})`) — buffer output silently

The renderer accesses buffered output via `logger.getChildBuffer(name)` and flushes it
as collapsible log groups on `orchestration:package:complete`.

**Buffered rendering flow:**
1. Orchestrator creates child loggers per package (via `Logger.child()`)
2. Core services write diagnostics to the child (buffered)
3. Renderer subscribes to events and also buffers event messages per-package
4. On `orchestration:package:complete`, renderer flushes all entries as an atomic group
5. Group header includes outcome and duration: `Build: my-package ✓ (12s)`

**Why buffering?** Packages within a dependency level run concurrently. Without buffering,
log groups from different packages would interleave, producing corrupt group nesting.

```typescript
// Renderer accesses the concrete logger type (actions-internal)
const buffer = logger.getChildBuffer('my-package');
logger.group(`Build: my-package ✓ (12s)`);
for (const entry of buffer) {
  // Writes via core.info/debug/error preserving level metadata
}
logger.groupEnd();
logger.clearChildBuffer('my-package');
```

This is injected into all core and orgs services. See [logging.instructions.md](./logging.instructions.md) for the full logging pattern.

## PR Validation Pipeline

### Flow

Two modes, selected via the `mode` option (default: `'local'`):

**`local` mode** (default — no scratch org, no DevHub):
1. **Resolve PR number** from `github.context.payload.pull_request.number`
2. **Build** with `validation: 'local'` and a `NimbusLocalValidator` (compile + dependency checks only)
3. **Set outputs** (success, per-package results; org fields left empty)

**`org` mode** (deploy to a pooled scratch org):
1. **Resolve PR number** from `github.context.payload.pull_request.number`
2. **Restore cached org** via `OrgCacheService.restore()` (keyed by PR number)
3. **If no cache hit**, fetch fresh org from pool via `PoolFetcher.fetch()`
4. **Authenticate** to the scratch org via JWT (parent username mechanism)
5. **Build** with `validation: 'org'` and `unlocked: {sourceOnly: true}` forced — PR validation must never create a real unlocked package version (that only happens on push to main, via the `build` action), so concurrent PRs never race for conflicting build numbers
6. **Resolve pending deploy validations** via `ValidationResolver` (actually deploys + reports pass/fail — `buildAll()` alone only confirms staging succeeded)
7. **Cache the org** for subsequent pushes via `OrgCacheService.save()`
8. **Set outputs** (success, org-username, org-id, cache-hit, etc.)

### Scratch Org Caching

Avoids consuming a fresh pool org on every push to the same PR:

```
Push 1 → No cache → Fetch from pool → Cache org → Deploy
Push 2 → Cache hit → Reuse same org → Deploy
Push 3 → Cache hit → Reuse same org → Deploy
Push N → Cache expired (TTL) → Fetch new org → Cache → Deploy
```

**Cache keys** are scoped by PR number: `sfpm-org-pr-42-<timestamp>`

GitHub Actions cache entries are **immutable** — you can't overwrite. The save key includes a timestamp, and restore uses prefix matching to find the latest entry.

**TTL** is configurable (default: 4 hours). When the cached entry's TTL expires, `restore()` returns `undefined` and a new org is fetched. This ensures long-lived PRs get fresh orgs periodically to avoid conflicts with other changes.

## Usage in Workflows

```yaml
name: PR Validation
on:
  pull_request:
    types: [opened, synchronize, reopened]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      # Authenticate to DevHub (JWT flow)
      - name: Authenticate DevHub
        run: sf org login jwt ...

      - name: Validate PR
        uses: b64hub/sfpm/packages/actions/validate-pr@<sha>
        with:
          mode: org
          devhub-username: devhub@myorg.com
          pool-tag: ci-pool
          cache-ttl-hours: '6'

      - name: Use outputs
        if: always()
        run: |
          echo "Success: ${{ steps.validate.outputs.success }}"
          echo "Org: ${{ steps.validate.outputs.org-username }}"
          echo "Cache hit: ${{ steps.validate.outputs.cache-hit }}"
```

## Action Inputs/Outputs

### Inputs

| Input | Required | Default | Description |
|-------|----------|---------|-------------|
| `mode` | No | `local` | `local` (nimbus checks only) or `org` (deploy to a pooled scratch org) |
| `devhub-username` | Only if `mode: org` | — | DevHub username or alias |
| `pool-tag` | Only if `mode: org` | — | Pool tag to fetch orgs from |
| `cache-ttl-hours` | No | `4` | How long to cache org per PR (org mode only) |
| `project-dir` | No | workspace root | SFPM project directory |
| `packages` | No | all | Comma-separated package names |

### Outputs

| Output | Description |
|--------|-------------|
| `success` | `true` / `false` |
| `org-username` | Scratch org username used |
| `org-id` | Scratch org ID |
| `cache-hit` | Whether a cached org was reused |
| `pr-number` | PR number validated |
| `duration` | Total duration in milliseconds |
| `result` | Full JSON result |

## Building

Each action is a JavaScript (`node24`) action. Each `action.yml` points `main:` at a single entry from a committed esbuild bundle at `packages/actions/bundle/`:

```yaml
runs:
  using: node24
  main: ../bundle/<entry>.mjs
```

Inputs arrive as `INPUT_*` environment variables automatically; outputs declare only `description:`, with values coming from `core.setOutput` at run time.

The bundle is built once at release time by `scripts/build-action-bundle.mjs`,
using actual esbuild bundling with code-splitting: all 8 action entrypoints are
bundled together (`splitting: true`) so the shared dependency graph (@salesforce/core,
@b64hub/sfpm-core, etc.) is stored once in `bundle/chunks/` instead of
duplicated per action. The bundle is roughly 15–20MB total for all 8 actions.

**Why not a pure single JS file with zero extra assets?** Three issues required
workarounds during bundling discovery:

1. **@salesforce/packaging** reads its own runtime message bundles from a
   `messages/` directory on disk (via `Messages.importMessagesDirectory`),
   which a bundled file cannot structurally provide. Fix: ship its real
   `package.json` and `messages/` directory as sibling files in the bundle.
2. **jiti** (used to load a consumer's own `sfpm.config.ts` at runtime — this
   must remain dynamic since that file doesn't exist at build time) does its
   own internal `require()` relative to its own module file, which breaks if
   inlined. Fix: mark it esbuild `external` and ship a real copy at
   `bundle/node_modules/jiti/`.
3. **@salesforce/core's Logger** optionally spawns a pino worker-thread
   transport for file-based logging, which needs a real file on disk once
   inlined. Fix: the bundle's esbuild banner sets
   `process.env.SF_DISABLE_LOG_FILE ??= 'true'`, which routes logging through
   an in-memory logger instead (also a better default for ephemeral runners).

`packages/actions/src/` compiles with `pnpm build` (plain TypeScript) to
`dist/*-main.js`. `scripts/build-action-bundle.mjs` re-bundles the 8
`src/*-main.ts` entrypoints directly with esbuild (not from `dist/`) into
`packages/actions/bundle/*-main.mjs`, which is committed and checked out
with the action, so no install step is needed at runtime.

## Testing

Follow the same patterns as other SFPM packages (see [testing.instructions.md](./testing.instructions.md)):

- Mock `@actions/core`, `@actions/cache`, `@actions/github`
- Mock `@salesforce/core` for auth operations
- Test cache TTL logic with time manipulation
- Test progress renderer with synthetic EventEmitter events

```typescript
vi.mock('@actions/core', () => ({
    debug: vi.fn(),
    error: vi.fn(),
    getInput: vi.fn(),
    info: vi.fn(),
    setFailed: vi.fn(),
    setOutput: vi.fn(),
    startGroup: vi.fn(),
    endGroup: vi.fn(),
    warning: vi.fn(),
}));
```

## Adding a New Action

1. Create `src/my-action.ts` with the pipeline logic
2. Create `src/my-action-main.ts` as the entry point (plain `tsc` output to `dist/my-action-main.mjs`, no bundler)
3. Register it in `scripts/build-action-bundle.mjs`'s `ENTRY_POINTS` list (`'src/my-action-main.ts'`)
4. Add `my-action/action.yml` (own subdirectory, following the `build/`, `install/`, `deploy/`, `build-validation/`, `fill-pool/` convention) as a node24 action with `main: ../bundle/my-action-main.mjs` — copy the `runs:` block from an existing `action.yml` and update only the entry filename
5. Export from `src/index.ts` for library use
6. Add tests with mocked `@actions/*` dependencies
7. Update this instructions file
