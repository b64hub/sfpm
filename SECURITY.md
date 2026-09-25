# Security Policy

## Reporting a vulnerability

Report privately via [GitHub Security Advisories](https://github.com/b64hub/sfpm/security/advisories/new).
Please do not open a public issue for a suspected vulnerability.

Expect an acknowledgement within 5 working days. Fixes ship in a patch release
on the current minor; the rolling `v0` tag is moved once the fix is released.

## Supported versions

Pre-1.0, only the latest release receives fixes. There are no backports to
earlier `v0.x` minors.

## Scope of the GitHub Actions

The actions under `packages/actions/` are the supported integration surface.
Runner prerequisites, the full network egress table, and allowlisting
guidance for a whitelisting review live in
[packages/actions/CONSUMING.md](packages/actions/CONSUMING.md). The summary
here:

**Permissions.** The actions do not read `GITHUB_TOKEN`, take no
`github-token` input, and make no GitHub API calls. `validate-pr` reads the PR
number and base SHA from the local event payload only. `contents: read` is
sufficient for every action; nothing requires write scope.

**Network egress.** There is no network egress required for action execution
itself; the bundle is committed and checked out with the action. The `install`
action accesses the npm registry for consumer package artifacts (separate use
case, `origin: registry`). Actions also reach the Salesforce DevHub and target
orgs, and `validate-pr` in `org` mode uses the GitHub Actions cache. See
CONSUMING.md for the full table.

There is no telemetry endpoint, no analytics, and no vendor callback. Tracing
is OpenTelemetry-based and inert unless *you* set
`OTEL_EXPORTER_OTLP_ENDPOINT` to your own collector; there is no default or
fallback endpoint anywhere in the codebase.

**Credential handling.** Actions assume the DevHub and target orgs are already
authenticated in the runner (typically via `sf` CLI and a JWT or auth
URL held in your own secrets). No org credential is written to the GitHub
Actions cache, passed between steps, or emitted as an action output —
`validate-pr` caches only the org username and ID, and re-resolves auth
through the DevHub. Installation keys and auth URLs are registered with
`core.setSecret()` so they are masked in logs.

**Distribution and pinning.** The actions are JavaScript (`node20`) actions. Each
`action.yml` points `main:` at an entry from a committed esbuild bundle at
`packages/actions/bundle/`. The bundle is built once at release time by
`scripts/build-action-bundle.mjs` using actual esbuild bundling (not a
vendored node_modules install). It includes two small shim assets that
are necessary for correct behavior: `@salesforce/packaging`'s `messages/`
directory (read at runtime) and a real copy of the `jiti` package (used
to load consumer sfpm.config files at runtime).

The bundle is built from the repo's already-compiled `dist/` output
(produced by `pnpm build`), so the same git commit always produces the same
bytes. Both the bundle source and the build script are reviewable, and
consumers can verify the bundle by re-running `node scripts/build-action-bundle.mjs`
from the release commit and diffing the result.

No dependency lifecycle scripts execute, so building or running the action
cannot run third-party code.

Runner prerequisites (Node.js, `sf` CLI, nimbus, authenticated orgs) and
allowlist entry formats are documented in
[packages/actions/CONSUMING.md](packages/actions/CONSUMING.md), not here.

## Versioning and pinning

| Reference | Mutability | Use for |
| --- | --- | --- |
| `v0.2.0` | immutable, protected create-only | audits, pinned production use |
| `v0` | moved on every release | convenience |
| commit SHA | immutable | strictest supply-chain policies |

Pre-1.0, `v0` may include breaking changes between minor versions. Pin
`v0.x.y` or a SHA if you need stability.
