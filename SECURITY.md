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
Their security posture:

**Permissions.** The actions do not read `GITHUB_TOKEN`, take no
`github-token` input, and make no GitHub API calls. `validate-pr` reads the PR
number and base SHA from the local event payload only. `contents: read` is
sufficient for every action; nothing requires write scope.

**Network egress.** Only:

- Salesforce APIs — the DevHub and target orgs you point the action at
- the npm registry — `install` with `origin: registry`, to resolve published
  package artifacts (run with `--ignore-scripts`; artifacts are never
  permitted to execute install hooks)
- the GitHub Actions cache — `validate-pr` org reuse

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

**Build provenance.** The committed action bundles are built by
`packages/actions/esbuild.config.mjs` from the TypeScript sources in the same
commit, unminified and with sourcemaps, so they can be diffed and reproduced.

## Versioning and pinning

| Reference | Mutability | Use for |
| --- | --- | --- |
| `v0.2.0` | immutable, protected create-only | audits, pinned production use |
| `v0` | moved on every release | convenience |
| commit SHA | immutable | strictest supply-chain policies |

Pre-1.0, `v0` may include breaking changes between minor versions. Pin
`v0.x.y` or a SHA if you need stability.
