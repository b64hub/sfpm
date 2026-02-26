---
description: GitHub Actions patterns for SFPM — PR validation, scratch org caching, and CI/CD integration
applyTo: 'packages/actions/src/**/*.ts'
---

## Package Overview

`@b64/sfpm-actions` provides GitHub Action wrappers around core SFPM functionality. It is a thin integration layer — all business logic lives in `@b64/sfpm-core` and `@b64/sfpm-orgs`.

### Package Structure

```
packages/actions/
  action.yml              # GitHub Action definition
  esbuild.config.mjs      # Bundler for single-file dist/main.js
  src/
    main.ts               # Action entry point (reads inputs, runs validatePr)
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
│  action.yml  │ ──> │   main.ts    │ ──> │   validate-pr.ts    │
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

- **`main.ts`** — reads `@actions/core` inputs, calls `validatePr()`, sets outputs
- **`validate-pr.ts`** — orchestrates the full pipeline (org resolution → deployment)
- **`org-cache.ts`** — manages `@actions/cache` for PR-scoped scratch org reuse
- **`logger.ts`** — `StructuredLogger` implementation using `@actions/core`
- **`progress-renderer.ts`** — subscribes to core EventEmitter events, logs them

### Logging

The actions package uses `GitHubActionsLogger` which implements `StructuredLogger`:

```typescript
const logger = createGitHubActionsLogger({ prefix: 'validate-pr' });
```

This is injected into all core and orgs services. See [logging.instructions.md](./logging.instructions.md) for the full logging pattern.

## PR Validation Pipeline

### Flow

1. **Resolve PR number** from `github.context.payload.pull_request.number`
2. **Restore cached org** via `OrgCacheService.restore()` (keyed by PR number)
3. **If no cache hit**, fetch fresh org from pool via `PoolFetcher.fetch()`
4. **Authenticate** to the scratch org via JWT (parent username mechanism)
5. **Deploy source** via `InstallOrchestrator.forSource()`
6. **Cache the org** for subsequent pushes via `OrgCacheService.save()`
7. **Set outputs** (success, org-username, org-id, cache-hit, etc.)

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
          node-version: '20'

      # Authenticate to DevHub (JWT flow)
      - name: Authenticate DevHub
        run: sf org login jwt ...

      - name: Validate PR
        uses: ./packages/actions
        with:
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
| `devhub-username` | Yes | — | DevHub username or alias |
| `pool-tag` | Yes | — | Pool tag to fetch orgs from |
| `cache-ttl-hours` | No | `4` | How long to cache org per PR |
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

The action requires bundling into a single file for GitHub Actions:

```bash
pnpm build       # TypeScript compilation
pnpm bundle      # esbuild → dist/main.js (single bundled file)
```

The `action.yml` points to `dist/main.js` as the entry point.

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
2. Create `src/my-action-main.ts` as the entry point
3. Add a new `action.yml` (or a composite action pointing to the entry point)
4. Add esbuild entry point if separate bundle needed
5. Export from `src/index.ts` for library use
6. Add tests with mocked `@actions/*` dependencies
7. Update this instructions file
