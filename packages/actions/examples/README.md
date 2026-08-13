# Testing example workflows locally with `act`

Requires [`act`](https://github.com/nektos/act) and a running Docker daemon.

## One-time setup

Build and tag the sfpm image locally (it isn't published anywhere yet, so
`act` needs to find it in the local Docker cache instead of pulling):

```bash
docker build -f packages/actions/docker/Dockerfile -t ghcr.io/b64hub/sfpm-actions:latest packages/actions/docker
```

`.actrc` (repo root) is already configured with `--pull=false` so `act` uses
that local image instead of trying to fetch it from ghcr.io.

## Running a workflow

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

## Testing from a real Salesforce project

This repo has no fixture Salesforce project, so meaningful testing (actually
building/validating packages) needs to happen from a real project's repo.
That repo's workflows can't use `uses: ./packages/actions/build` directly —
that path only resolves within this repo's own checkout, and `dist/` isn't
published anywhere a remote `uses:` could pull from. Checkout this repo as a
sibling directory, build it, then reference the local path inside it:

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
      pnpm turbo build --filter=@b64hub/sfpm-actions...

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
          pnpm turbo build --filter=@b64hub/sfpm-actions...

      - uses: ./.sfpm-actions/packages/actions/validate-pr
```

The bind-mount target must match the container's real working directory path
(the same absolute path as the consuming project's checkout — act mirrors the
host path 1:1), and nothing on the host side should already exist at
`.sfpm-actions`, or `actions/checkout`'s copy step will try to write into the
mount.

`--ignore-scripts` on the sfpm-actions `pnpm install` skips its `husky
install` postinstall hook, which fails outside a real git checkout (a plain
bind mount has no `.git`). Also watch for turbo/tsc output collisions if
you've run both `pnpm build` (tsc) and `pnpm bundle` (esbuild) locally on the
same sfpm checkout — they write to the same `dist/*.js` filenames, and
turbo's cache can replay a stale one. `rm -rf packages/actions/dist
packages/actions/tsconfig.tsbuildinfo && pnpm turbo build --force` if a test
is running against unexpectedly old code.

## Debugging an action inside a consuming project

`act-tests/` has bind-mount-flavored copies of `build.yml`, `fill-pool.yml`,
and `validate-pr.yml` meant to be dropped into a *consuming* project's
`.github/act-tests/` — they skip the `sfpm-actions` container entirely (a
container job can't be reached by a debugger the same way) and install the
same toolchain directly on the runner instead. See
packages/actions/DEBUGGING.md for the full attach-a-debugger walkthrough.
