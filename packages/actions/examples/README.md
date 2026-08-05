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

`build.yml` and `provision-pool.yml` need real secrets (`SFDX_CONSUMER_KEY`,
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
your local edits. Symlink instead, and skip that checkout step locally:

```bash
# from the consuming project's root
ln -s /path/to/sfpm .sfpm-actions
```
