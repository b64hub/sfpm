# SFPM — Salesforce Package Manager

```
  ███████╗███████╗██████╗ ███╗   ███╗
  ██╔════╝██╔════╝██╔══██╗████╗ ████║
  ███████╗█████╗  ██████╔╝██╔████╔██║
  ╚════██║██╔══╝  ██╔═══╝ ██║╚██╔╝██║
  ███████║██║     ██║     ██║ ╚═╝ ██║
  ╚══════╝╚═╝     ╚═╝     ╚═╝     ╚═╝
```

_by developers, for developers_

[![tests](https://github.com/b64hub/sfpm/actions/workflows/test.yml/badge.svg)](https://github.com/b64hub/sfpm/actions/workflows/test.yml)
![node](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/b64hub/sfpm/main/package.json&label=node&query=$.engines.node&color=brightgreen)
![pnpm](https://img.shields.io/badge/dynamic/json?url=https://raw.githubusercontent.com/b64hub/sfpm/main/package.json&label=pnpm&query=$.engines.pnpm&color=F69220)
![license](https://img.shields.io/badge/license-MIT-blue)
[![Conventional Commits](https://img.shields.io/badge/Conventional%20Commits-1.0.0-yellow.svg)](https://www.conventionalcommits.org/)

> **Status: early-stage (v0.1.0, "Seedling")** — APIs and commands may change.
> <img width="1280" height="760" alt="Image" src="https://github.com/user-attachments/assets/b290d673-5da5-4cfb-84e1-75a2370f3829" />

## What is SFPM?

SFPM is a CLI and toolchain that brings a modern package-manager workflow to Salesforce metadata. It builds Salesforce packages into versioned artifacts, installs or deploys them across orgs in dependency order, and runs lifecycle hooks for the metadata types Salesforce doesn't handle cleanly out of the box (profiles, permission sets, picklists, flows, managed-package settings, and more).

Think `npm`, but the artifacts are unlocked / second-generation Salesforce packages instead of JavaScript modules.

## Why use it?

- **Dependency-aware orchestration** — build and deploy graphs of packages with one command instead of hand-rolling order.
- **Async validation watchers** — kick off long unlocked-package builds and check back later with `sfpm build status`.
- **Lifecycle hooks** — pre/post-deploy logic for the metadata Salesforce makes painful: profiles, perm sets, picklists, flows, LWC, managed packages, Browserforce settings.
- **Scratch org pools** — provision and reuse warm scratch orgs to cut feedback time.
- **Data seeding** — first-class [SFDMU](https://github.com/forcedotcom/SFDX-Data-Move-Utility) integration for reference data.
- **CI-ready** — every flow that runs locally also ships as a GitHub Action.
- **Turborepo-friendly** — `--turbo` flag on `build` / `deploy` / `install` for single-package mode under external orchestrators.

## Repository layout

This is a pnpm + Turborepo monorepo:

| Package                                 | Purpose                                                                          |
| --------------------------------------- | -------------------------------------------------------------------------------- |
| [`@b64hub/sfpm-cli`](packages/cli/)        | The `sfpm` CLI (oclif).                                                          |
| [`@b64hub/sfpm-core`](packages/core/)      | Build/install orchestrators, artifact registry, lifecycle engine, project model. |
| [`packages/actions`](packages/actions/) | GitHub Actions wrapping the same flows for CI.                                   |
| [`packages/hooks`](packages/hooks/)     | Pre/post-deploy hooks for tricky metadata.                                       |
| [`packages/orgs`](packages/orgs/)       | Scratch org and pool management.                                                 |
| [`packages/sfdmu`](packages/sfdmu/)     | SFDMU data builder/installer integration.                                        |

## Requirements

- Node.js **>= 18**
- **pnpm >= 8** (do not use `npm` or `yarn` for the workspace)
- Salesforce CLI (`sf`) authenticated to your DevHub and target orgs
- Git

## Installation

### From source

```bash
git clone https://github.com/b64hub/sfpm.git
cd sfpm
pnpm install
pnpm build
# Run via the local binary
node packages/cli/bin/run.js --help
# Or link it for global use
pnpm --filter @b64hub/sfpm-cli link --global
```

## Quick start

```bash
# 1. Initialize an SFPM project
sfpm project init

# 2. Bootstrap the SFPM helper packages into your DevHub/prod org
sfpm bootstrap -o my-devhub

# 3. Build a package (or several) against your DevHub
sfpm build my-package -v my-devhub

# 4. Deploy from local source to a sandbox
sfpm deploy my-package -o my-sandbox

# 5. Install a previously built artifact into a target org
sfpm install my-package -o my-sandbox
```

## Commands

Top-level command reference — run `sfpm <command> --help` for full flags.

### Project setup

| Command                     | Description                                                                                                  |
| --------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `sfpm project init`         | Verify project configuration and setup requirements.                                                         |
| `sfpm project init turbo`   | Initialize a Turborepo-native workspace for SFPM packages.                                                   |
| `sfpm project sync`         | Generate `sfdx-project.json` from workspace `package.json` files.                                            |
| `sfpm project version bump` | Bump package versions in `sfdx-project.json`.                                                                |
| `sfpm bootstrap -o <org>`   | Install the SFPM helper packages (artifact tracking, pool, UI) into a DevHub. Tiers: `core`, `pool`, `full`. |

### Build & deploy

| Command                                     | Description                                                                                                                                    |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `sfpm build <packages…> -v <devhub>`        | Build one or more packages, in dependency order. Supports `--async-validation`, `--skip-validation`, `--no-dependencies`, `--turbo`, `--json`. |
| `sfpm build status`                         | Check the status of async package validation watchers.                                                                                         |
| `sfpm deploy <packages…> -o <org>`          | Deploy packages from local source via `source:deploy`.                                                                                         |
| `sfpm deploy artifact <packages…> -o <org>` | Deploy from previously built artifacts using source-deploy.                                                                                    |
| `sfpm install <packages…> -o <org>`         | Install packages (from artifacts) into a target org.                                                                                           |

### Scratch org pools

| Command               | Description                    |
| --------------------- | ------------------------------ |
| `sfpm pool provision` | Provision orgs to fill a pool. |
| `sfpm pool list`      | List orgs in a pool.           |
| `sfpm pool fetch`     | Fetch an org from a pool.      |
| `sfpm pool delete`    | Delete orgs from a pool.       |

## Configuration

SFPM reads project configuration from `sfpm.config.{ts,js,mjs}` at the project root (TypeScript preferred). The file is loaded with [`jiti`](https://github.com/unjs/jiti), so no build step is required.

```ts
// sfpm.config.ts
import { defineConfig } from '@b64hub/sfpm-core';

export default defineConfig({
  namespace: 'myns',
  sourceApiVersion: '62.0',
  hooks: [
    // lifecycle hook plugins
  ],
  artifacts: {
    trackHistory: true,
  },
  ignoreFiles: [
    // glob patterns excluded from package builds
  ],
});
```

Relevant environment variables:

- `SF_DEV_HUB` — default `--target-dev-hub` for `sfpm build`.
- `SF_TARGET_ORG` — default `--target-org` for `sfpm deploy` / `install`.
- `SFPM_FORCE_BUILD` — equivalent to `sfpm build --force`.
- `SFPM_PROJECT_DIR` — override the project directory (debugging).

If no config file is present, SFPM falls back to sensible defaults driven by `sfdx-project.json`.

## CI integration

The same orchestrators ship as GitHub Actions in [packages/actions/](packages/actions/):

- [`build-action.yml`](packages/actions/build-action.yml) — build packages.
- [`build-resume-action.yml`](packages/actions/build-resume-action.yml) — resume async validation.
- [`provision-pool-action.yml`](packages/actions/provision-pool-action.yml) — fill a scratch org pool.

## Development

```bash
pnpm install      # install workspace deps
pnpm build        # turbo build all packages
pnpm watch        # rebuild on change
pnpm test         # run vitest/mocha across the workspace
pnpm typecheck    # tsc -b across the workspace
pnpm lint         # eslint
pnpm format       # prettier
```

Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint + Husky).

## Contributing

Issues and PRs are welcome at <https://github.com/b64hub/sfpm/issues>. Please:

1. Open an issue first for non-trivial changes.
2. Use Conventional Commit messages (`feat:`, `fix:`, `chore:`, …).
3. Run `pnpm lint && pnpm typecheck && pnpm test` before pushing.

## License

[MIT](LICENSE)
