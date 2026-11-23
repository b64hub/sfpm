---
name: sfpm
description: Build, deploy, install and release Salesforce packages with sfpm and Turborepo. Use when working in an sfpm/pnpm workspace, running sfpm or turbo sfpm:* tasks, creating packages, managing scratch org pools, or releasing.
---

# sfpm

sfpm is a Salesforce package manager CLI. Packages are npm-style workspace packages
(pnpm workspaces), orchestrated across the repo by Turborepo. Use `sfpm <command> --help`
for the full flag list of any command; this skill covers workflows and rules, not flag tables.

## Workspace model

- Packages live in pnpm workspace directories. Each package has a `package.json` with an
  `sfpm` field (package type, etc.) and its own Salesforce source.
- `sfdx-project.json` is GENERATED and gitignored. Never hand-edit it. Regenerate it with
  `sfpm project sync` after changing workspace packages or their `package.json` files.
- `sfpm project` prints an overview of packages and their dependency graph.
- `sfpm project init` is read-only: it verifies project setup (git, remote, sfdx-project.json,
  packages). `--fix` does not change anything; it only prints guidance for each failed check.
- `sfpm project init turbo` scaffolds a turbo-based workspace, or migrates one with `--migrate`.
  It writes root and per-package `sfpm:*` scripts and a `turbo.json` with sfpm task definitions.

## Orchestration with Turborepo

Run work across the whole workspace through turbo so its caching and dependency graph apply:

- `turbo run sfpm:build` (or root `pnpm sfpm:build`) builds packages in dependency order.
- `turbo run sfpm:deploy` (or `pnpm sfpm:deploy`) deploys from local source.
- `turbo run sfpm:install` (or `pnpm sfpm:install`) installs into an org; it depends on `sfpm:build`.
- Scope to changed packages with turbo filters, e.g. `turbo run sfpm:build --filter=...[origin/main]`
  or `--filter=<package-name>...` to include dependencies.
- Per-package scripts call `sfpm <verb> <pkg> --turbo`. That flag is for turbo-invoked scripts only:
  single-package mode, plain output, and a result file written to `dist/<command>-result.json`.
  Do not pass `--turbo` by hand.
- For ad-hoc work, call sfpm directly (`sfpm build <pkgs>`, `sfpm deploy <pkgs>`). sfpm resolves
  package dependencies itself, so you do not need turbo for a handful of packages.

## Tests

Tests are NOT an sfpm command. Each package defines its own `test` script in its `package.json`
(Apex tests, Jest for LWC via `@b64hub/sfpm-jest`, etc.). Run them with `turbo run test`
(or `pnpm test` at the root). Turbo runs `build` first (`dependsOn: ["build"]`) and caches results.
Scope with turbo filters, e.g. `turbo run test --filter=<package-name>`.

## Common sequences

1. New workspace, first time: `sfpm project init` (verify), then `sfpm project init turbo` (scaffold),
   then `sfpm project sync` (regenerate `sfdx-project.json`), then `sfpm project` (confirm the graph).
2. Change one package and check it: `sfpm build <pkg>`, then `sfpm deploy <pkg> --target-org <alias>`
   against a scratch org or sandbox the user has confirmed.
3. Whole-workspace CI-style run: `turbo run sfpm:build --filter=...[origin/main]`, then
   `turbo run test`, with the same filter.
4. Cut a release: `sfpm build <pkgs>`, `sfpm release create -n <name>`, review the generated YAML, then
   `sfpm release run release/<name>.yaml --target-org <alias>` after confirming the org.

## Agent conventions

- Pass `--json` for machine-readable output. The result is wrapped in an envelope:
  `{command, duration, status, result, error}`. `status` is `success` or `error`; read `error.message` on failure.
- Pass `--plain` for non-interactive output. It is also automatic in CI and when stdout is not a TTY.
- Detailed run logs are written to `.sfpm/logs/<runId>.log` (full-fidelity JSON lines). When a
  command fails and the console output is not enough, read the newest file there.
- Commands that take `--log-level` (or `SFPM_LOG_LEVEL`) print more diagnostics to stderr.

## Command workflows

- **Package creation**: `sfpm package create` scaffolds a new package in the workspace (interactive
  unless flags are given; `--json` for CI). `sfpm add <pkgs>` adds sfpm packages as dependencies of the
  current project using pnpm.
- **Build**: `sfpm build <pkgs>` builds packages and their dependencies, and validates them. Use
  `--async` to return immediately while validation runs in a background watcher. Check progress with
  `sfpm build status`. Manage background watchers with `sfpm watch status`, `sfpm watch cancel`,
  and `sfpm watch clean` (removes completed, errored, and orphaned watcher state files).
- **Deploy**: `sfpm deploy <pkgs> --target-org <alias>` deploys packages from local project source.
  `sfpm deploy artifact <pkgs> --target-org <alias>` deploys from packages that were already built,
  so the source you deploy is exactly the built artifact.
- **Install**: `sfpm install <pkgs> --target-org <alias>` installs built package versions into an org,
  including their dependencies unless `--no-dependencies` is passed.
- **Publish**: `sfpm publish [pkgs]` publishes packages from their `dist` directories (no args or `all` means every workspace package). Use `--dry-run` first; `--tag` sets the npm dist-tag (default `latest`).
- **Releases**: `sfpm release create -n <name> [pkgs]` resolves each package's version from git tags (`--ref`, default `main`) and writes `release/<name>.yaml`; with no selection flags in a terminal it runs a guided walkthrough.
  `sfpm release run <file> --target-org <alias>` installs the packages listed in that definition.
- **Scratch org pools**: `sfpm pool fill --tag <tag> --max <n> -d <scratch-def> -v <devhub>` creates
  orgs in a pool. `sfpm pool list [--tag <tag>]` shows pool contents. `sfpm pool fetch --tag <tag>` takes an org
  out of the pool for use. `sfpm pool delete` removes orgs from a pool.
- **Versioning**: `sfpm project version bump` bumps package versions in `sfdx-project.json` (which is
  regenerated from the workspace; see Workspace model).
- **Bootstrap**: `sfpm bootstrap -o <org>` brings the packages into a production org, tier by tier. The org must also be a DevHub. It decides per package whether to build, promote, install, or skip, based on DevHub and target org state, and reruns skip packages already done.

## Safety rules

- `sfpm deploy`, `sfpm install`, `sfpm release run`, `sfpm bootstrap`, `sfpm publish`, and
  `sfpm pool delete` change real orgs, registries, or scratch org pools. Before running any of them,
  confirm the target org alias, DevHub, or registry with the user.
- Never run `sfpm pool delete` (or any destructive pool operation) without asking first.
- Do not run `sfpm bootstrap --force` (rebuilds, re-promotes, and re-installs everything) or `sfpm build --force`
  (builds with no source changes) unless the user asked for it.
- Do not edit `.sfpm/` state files or `sfdx-project.json` by hand; regenerate or rerun the command instead.
- Do not commit `.sfpm/`, `.sfdx/`, `.sf/`, or generated artifacts.

## Flags

Run `sfpm <command> --help` for the full flag list of any command. The flags are generated from the
command definitions and stay in sync with the CLI; do not copy them from memory.
