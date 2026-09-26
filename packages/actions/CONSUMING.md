# Consuming the SFPM GitHub Actions

This is the reference for platform/security reviewers and consuming teams:
runner prerequisites, network egress, allowlisting, and a minimal workflow.
For the project's general security policy (vulnerability reporting, supported
versions, credential handling), see [SECURITY.md](../../SECURITY.md).

## What these actions are

JavaScript actions (`runs: using: node24`). Each `action.yml` points `main:` at a single entry from an esbuild bundle that exists only in the commit a release tag points to (never on `main`):

```yaml
runs:
  using: node24
  main: ../bundle/<entry-file>.mjs
```

The bundle is at `packages/actions/bundle/`, built once at release time by
`scripts/build-action-bundle.mjs`. It contains 8 per-action entry files
(e.g. `validate-main.mjs`, `build-main.mjs`) plus shared dependency code
in a `chunks/` directory, so dependencies like `@salesforce/core` are stored
once instead of duplicated per action. Two small shim assets are also shipped:
`@salesforce/packaging`'s `messages/` directory (read at runtime) and a real
copy of the `jiti` package (used to load consumer sfpm.config files).
Total size is roughly 15–20MB for all 8 actions combined.

## Runner prerequisites

The actions install none of these. They must already be present before any
sfpm step runs:

| Requirement | Why | Provided by |
| --- | --- | --- |
| Node 24 | Actions use `runs.using: node24` | GitHub Actions runner v2.327.1+ (minimum for node24 support, per actions/checkout@v5 and actions/upload-artifact@v6). For self-hosted or GHES runners, confirm your version supports node24. |
| npm on PATH | The `install` action runs `npm install` for registry-origin packages. | Consumer (runner image or `actions/setup-node`) |
| `sf` CLI on PATH | Org auth and Salesforce operations | Consumer |
| DevHub and target orgs authenticated | Actions never handle credentials | Consumer (for example JWT with their own secrets) |
| nimbus on PATH | Local validation. Skipped with a warning if absent — a green run is not proof validation ran | Consumer, optional but recommended, through an approved channel |
| `contents: read` | Checkout only. Actions don't use `GITHUB_TOKEN` | Consumer workflow `permissions:` |

## Network egress

| Destination | Used by | When |
| --- | --- | --- |
| npm registry or configured mirror | `install` | Only with `origin: registry` (consumer package artifacts) |
| Salesforce DevHub and target orgs | All except the local mode of `validate-pr` | Every run |
| GitHub Actions cache service | `validate-pr` (`mode: org`) | Org reuse per PR |

There is no network egress for action execution itself. The bundle is part of
the release tag commit and is downloaded with the action, so no install step is
needed at runtime.

**A registry mirror is supported** for the `install` action's own package
installs (consumer artifacts). npm's default `replace-registry-host` behavior
will apply to those registrations. Consumers with an internal mirror only need
to allow that mirror for this use case. The `install` action passes `--ignore-scripts`
to `npm install`, so no dependency lifecycle scripts run for installed consumer
packages either.

There is no telemetry. OpenTelemetry export only happens if the consumer sets
`OTEL_EXPORTER_OTLP_ENDPOINT` to their own collector; there is no default or
fallback endpoint.

**Bundled environment variables:** The bundle sets `SF_DISABLE_LOG_FILE=true` unless already set in the environment.
This disables file-based logging in `@salesforce/core` (which doesn't work reliably in ephemeral runners anyway)
and routes logging through in-memory buffers instead. Child processes the actions spawn inherit this environment variable.

## Allowlisting

- The actions are referenced by sub-path (`b64hub/sfpm/packages/actions/<name>`),
  not the bare repo. An allowlist entry of bare `b64hub/sfpm` may not match
  that reference. **Expected format** (not yet verified against a real org policy):
  `b64hub/sfpm/packages/actions/*@<sha>`. Verify in your own org before relying on it.
- The sfpm actions add no further `uses:` dependencies — no action here
  contains a nested `uses:`. The allowlist footprint is exactly the sfpm
  actions themselves. A typical consuming workflow also needs
  `actions/checkout`, `actions/setup-node`, and, for a build pipeline,
  `actions/upload-artifact` and `actions/download-artifact`.
- **Pin the tag commit of a release**, not a `main` commit or arbitrary commit.
  The bundle at `packages/actions/bundle/` exists only on the commit a release
  tag points to, never on `main`. A SHA pinned to a non-release commit or a
  `main` commit will have no bundle and the action will fail. Use
  `git rev-parse v<major>.<minor>.<patch>^{commit}` to find the tag commit's SHA,
  or copy the SHA shown in the GitHub release.

## Minimal consumer workflow

```yaml
name: SFPM Build

on:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: '22'

      # Install the sf CLI and nimbus, and authenticate DevHub/target orgs,
      # through your own approved channels. The actions do none of this.
      # Note: the `sf` CLI commands below (e.g., `sf org login jwt`) are your own
      # separate steps and are not invoked by the sfpm actions themselves — all
      # Salesforce operations inside the actions use the @salesforce/core and
      # @salesforce/packaging SDKs as libraries, not the sf CLI binary.
      - name: Install prerequisites and authenticate
        run: |
          npm install --global @salesforce/cli
          sf org login jwt \
            --client-id "${{ secrets.SFDX_CONSUMER_KEY }}" \
            --jwt-key-file server.key \
            --username "${{ secrets.DEVHUB_USERNAME }}" \
            --set-default-dev-hub \
            --alias devhub

      - name: Build packages
        uses: b64hub/sfpm/packages/actions/build@<sha>
        with:
          devhub-username: devhub
```

Replace `<sha>` with the commit SHA of the sfpm release you're pinning to.
