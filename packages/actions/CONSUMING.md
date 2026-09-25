# Consuming the SFPM GitHub Actions

This is the reference for platform/security reviewers and consuming teams:
runner prerequisites, network egress, allowlisting, and a minimal workflow.
For the project's general security policy (vulnerability reporting, supported
versions, credential handling), see [SECURITY.md](../../SECURITY.md).

## What these actions are

Composite actions (`runs: using: composite`) — plain shell steps, not bundled
JavaScript. Each `action.yml` installs a shared, pinned dependency tree from
`packages/actions/runtime` and runs a small dispatcher out of it:

```bash
runtime="$GITHUB_ACTION_PATH/../runtime"
[ -d "$runtime/node_modules" ] || npm ci --prefix "$runtime" --ignore-scripts
"$runtime/node_modules/.bin/sfpm-action" <action-name>
```

`$runtime` resolves inside the runner's checkout of the action itself, not
the consumer's workspace — a consumer-side `npm ci` does not satisfy it. The
first sfpm action in a job performs the install; every later sfpm action in
that same job reuses the resulting `node_modules`.

Bundling this into a single committed JS file isn't viable today: esbuild
fails on `@salesforce/core`'s import/require patterns. That's why the runtime
is a pinned, `npm ci`-installed lockfile instead of a committed bundle.

## Runner prerequisites

The actions install none of these. They must already be present before any
sfpm step runs:

| Requirement | Why | Provided by |
| --- | --- | --- |
| Node.js 22 LTS or newer, with npm | Composite step runs `npm ci` and `node` | Consumer (`actions/setup-node` or runner image) |
| `sf` CLI on PATH | Org auth and Salesforce operations | Consumer |
| DevHub and target orgs authenticated | Actions never handle credentials | Consumer (for example JWT with their own secrets) |
| nimbus on PATH | Local validation. Skipped with a warning if absent — a green run is not proof validation ran | Consumer, optional but recommended, through an approved channel |
| `contents: read` | Checkout only. Actions don't use `GITHUB_TOKEN` | Consumer workflow `permissions:` |

## Network egress

| Destination | Used by | When |
| --- | --- | --- |
| npm registry or configured mirror | Every action | First sfpm action in each job (`npm ci` of the pinned runtime) |
| npm registry or configured mirror | `install` | Only with `origin: registry` (consumer package artifacts) |
| Salesforce DevHub and target orgs | All except the local mode of `validate-pr` | Every run |
| GitHub Actions cache service | `validate-pr` (`mode: org`) | Org reuse per PR |

**A registry mirror is supported.** npm's default `replace-registry-host`
behavior sends the runtime lockfile's `registry.npmjs.org` URLs to whatever
registry the runner is configured with, and integrity hashes are still
verified against the lockfile. Consumers with an internal mirror only need to
allow that mirror, not `registry.npmjs.org` itself.

There is no telemetry. OpenTelemetry export only happens if the consumer sets
`OTEL_EXPORTER_OTLP_ENDPOINT` to their own collector; there is no default or
fallback endpoint.

## Allowlisting

- The actions are referenced by sub-path (`b64hub/sfpm/packages/actions/<name>`),
  not the bare repo. An allowlist entry of bare `b64hub/sfpm` may not match
  that reference. **Tested format:** `b64hub/sfpm/packages/actions/*@<sha>`.
- The sfpm actions add no further `uses:` dependencies — no action here
  contains a nested `uses:`. The allowlist footprint is exactly the sfpm
  actions themselves. A typical consuming workflow also needs
  `actions/checkout`, `actions/setup-node`, and, for a build pipeline,
  `actions/upload-artifact` and `actions/download-artifact`.
- Recommend pinning a commit SHA rather than a tag. A SHA pins both
  `action.yml` and the runtime lockfile it ships with, so the whole
  transitive dependency tree is fixed, not just the entrypoint.

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
