# Testing example workflows locally with `act`

**For sfpm contributors only.** These instructions test the action source in
this checkout with `act` and a local Docker image; they are not part of the
consumer-facing docs. Consumers should use the workflows in this directory as
templates and reference the actions remotely
(`b64hub/sfpm/packages/actions/<name>@<sha>`) as shown in each file — see
[../CONSUMING.md](../CONSUMING.md).

Requires [`act`](https://github.com/nektos/act) v0.2.81 (released 2025-09-01) or later for node24 action support, and a running Docker daemon.

## One-time setup

Build and tag the sfpm image locally (it's a local/`act` convenience image
only, not published anywhere, so `act` needs to find it in the local Docker
cache instead of pulling):

```bash
docker build -f packages/actions/docker/Dockerfile -t ghcr.io/b64hub/sfpm-actions:latest packages/actions/docker
```

`.actrc` (repo root) is already configured with `--pull=false` so `act` uses
that local image instead of trying to fetch it from ghcr.io.

## Running a workflow

First, build the action bundle locally (required — `act` runs the `.mjs` files in `packages/actions/bundle/`):

```bash
pnpm build
node scripts/build-action-bundle.mjs
```

Then run your chosen workflow:

```bash
act pull_request \
  -W packages/actions/examples/validate-pr.yml \
  --eventpath .github/act/pull_request.json \
  -j validate
```

`validate-pr.yml`'s default (`local`) mode needs no secrets or org access —
it's the easiest one to exercise end-to-end. It'll get through checkout,
install, build, and the action itself, then fail with "No workspace packages
with an 'sfpm' field found" — expected, since this repo builds the sfpm tool
itself and has no fixture Salesforce project. That's as far as testing goes
without a real (or fixture) SF project checked out alongside it.

`build.yml` and `fill-pool.yml` need real secrets (`SFDX_CONSUMER_KEY`,
`SFDX_JWT_KEY`, `DEVHUB_USERNAME`, `TARGET_ORG_USERNAME`, `NPM_TOKEN`) to get
past the `sf org login jwt` step — pass them with `-s NAME=value` or a
`--secret-file` (see `act`'s docs). Without them they'll fail at that step,
which still confirms the workflow YAML and action wiring are structurally
sound even without live credentials.

## Files

- `.actrc` (repo root) — default platform image + `--pull=false`
- `.github/act/pull_request.json` — minimal `pull_request` event payload
  (`resolvePrNumber()` in `validate-pr.ts` needs `pull_request.number`)

## Testing against a real Salesforce project (debugging option)

This repo has no fixture Salesforce project, so meaningful testing (actually
building/validating packages) needs to happen from a real project's repo.
The recipe below checks out sfpm as a sibling directory and references it by
local path — this is a debugging convenience for sfpm contributors, not
something a consuming workflow should do. A real consuming workflow always
uses the remote `uses: b64hub/sfpm/packages/actions/<name>@<sha>` form (see
[../CONSUMING.md](../CONSUMING.md)); it never needs its own checkout of sfpm.

```yaml
steps:
  - uses: actions/checkout@v4   # the consuming project itself

  - uses: actions/checkout@v4
    with:
      repository: b64hub/sfpm
      path: .sfpm-actions

  - uses: pnpm/action-setup@v4
  - run: |
      cd .sfpm-actions
      pnpm install
      pnpm build
      node scripts/build-action-bundle.mjs

  - uses: ./.sfpm-actions/packages/actions/build
    with:
      devhub-username: devhub
```

Secrets (`SFDX_CONSUMER_KEY`, `SFDX_JWT_KEY`, `DEVHUB_USERNAME`,
`TARGET_ORG_USERNAME`, `NPM_TOKEN`) belong on that project's repo —
**Settings → Secrets and variables → Actions → New repository secret** —
not on this one.

For local `act` runs against not-yet-pushed sfpm changes, the
`checkout repository: b64hub/sfpm` step would pull whatever's on GitHub, not
your local edits. A symlink doesn't work here — act's local checkout copies
files into the container (`docker cp`), and a symlink pointing outside the
working directory just becomes a dangling link once copied. Bind-mount your
local sfpm checkout into the container instead, via the job's `container.options`
(this is real `container:` syntax, not act-specific — see
[GitHub's docs](https://docs.github.com/en/actions/using-jobs/running-jobs-in-a-container#example-running-a-job-within-a-container)):

```yaml
jobs:
  validate:
    runs-on: ubuntu-latest
    container:
      image: ghcr.io/b64hub/sfpm-actions:latest
      options: -v /path/to/sfpm:/path/to/consuming-project/.sfpm-actions
    steps:
      - uses: actions/checkout@v4

      - run: |
          cd .sfpm-actions
          pnpm install --ignore-scripts
          pnpm build
          node scripts/build-action-bundle.mjs

      - uses: ./.sfpm-actions/packages/actions/validate-pr
```

The bind-mount target must match the container's real working directory path
(the same absolute path as the consuming project's checkout — act mirrors the
host path 1:1), and nothing on the host side should already exist at
`.sfpm-actions`, or `actions/checkout`'s copy step will try to write into the
mount.

`--ignore-scripts` on the sfpm-actions `pnpm install` skips its `husky
install` postinstall hook, which fails outside a real git checkout (a plain
bind mount has no `.git`).

If you modify action source code, rebuild the bundle afterwards:

```bash
node scripts/build-action-bundle.mjs
```

If in doubt, delete the entire bundle and rebuild from scratch:

```bash
rm -rf packages/actions/bundle
node scripts/build-action-bundle.mjs
```

`act` always runs whatever `.mjs` files are in `bundle/` regardless of whether
sources have changed, so stale bundle output is a common debugging issue.

## Debugging an action inside a consuming project

`act-tests/` has bind-mount-flavored copies of `build.yml`, `fill-pool.yml`,
and `validate-pr.yml` meant to be dropped into a *consuming* project's
`.github/act-tests/` — they skip the `sfpm-actions` container entirely (a
container job can't be reached by a debugger the same way) and install the
same toolchain directly on the runner instead. See
packages/actions/DEBUGGING.md for the full attach-a-debugger walkthrough.

### Debugging with `NODE_OPTIONS=--inspect-brk`

When you add `NODE_OPTIONS: --inspect-brk` to debug an action, **note that
you are debugging the bundled code** (the `.mjs` files under
`packages/actions/bundle/`), not the original TypeScript sources. Breakpoints
and step-through will show line numbers and file paths from the bundled output.

This build script does not currently emit source maps, so source-level mapping
is not available. If you need to match breakpoints to source code, use a text
comparison: open both the original `src/*.ts` file and the bundled
`bundle/*-main.mjs` side-by-side and search for the source code text in the
bundled file to find the corresponding location.
