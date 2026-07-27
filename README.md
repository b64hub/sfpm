# SFPM — Salesforce Package Manager

[![npm](https://img.shields.io/npm/v/@b64hub/sfpm-cli)](https://www.npmjs.com/package/@b64hub/sfpm-cli)
[![tests](https://github.com/b64hub/sfpm/actions/workflows/test.yml/badge.svg)](https://github.com/b64hub/sfpm/actions/workflows/test.yml)
![license](https://img.shields.io/badge/license-MIT-blue)

> **Status:** early beta (v0.1.0). APIs and commands may change without notice.

## Why SFPM

Salesforce's native tooling doesn't treat metadata like a modern package graph. Dependencies between packages, deploy ordering, and lifecycle quirks (profiles, permission sets, picklists, flows, managed-package settings) are usually handled with ad hoc scripts.

SFPM brings a package-manager workflow to Salesforce metadata: unlocked packages and metadata source files are built into versioned artifacts, deployed across orgs in dependency order, and run through lifecycle hooks for the metadata types that don't behave well by default. Think `npm`, but the artifacts are Salesforce packages instead of JavaScript modules.

## Features

- Dependency-aware build and deploy orchestration
- Async validation for long-running unlocked-package builds
- Metadata source deployments as distributed packages
- Lifecycle hooks for metadata Salesforce handles poorly out of the box
- Org pool management for faster feedback loops 
  - Supporting both sandboxes and scratch orgs
- Data seeding via [SFDMU](https://github.com/forcedotcom/SFDX-Data-Move-Utility)
- GitHub Actions for the same flows used locally

## Packages

This is a pnpm + Turborepo monorepo.

| Package | Purpose |
| --- | --- |
| [`@b64hub/sfpm-cli`](packages/cli/) | The `sfpm` CLI (built on oclif). |
| [`@b64hub/sfpm-core`](packages/core/) | Build/install orchestrators, artifact registry, lifecycle engine, project model. |
| [`@b64hub/sfpm-actions`](packages/actions/) | GitHub Actions wrapping the core flows for CI. |
| [`@b64hub/sfpm-hooks`](packages/hooks/) | Pre/post-deploy hooks for tricky metadata. |
| [`@b64hub/sfpm-orgs`](packages/orgs/) | Scratch org and pool management. |
| [`@b64hub/sfpm-sfdmu`](packages/sfdmu/) | SFDMU data builder/installer integration. |

## Requirements

- Node.js >= 18
- pnpm >= 8 (required for workspace development; end users installing the CLI can use any package manager)
- [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli) (`sf`), authenticated to your DevHub and target orgs
- Git

## Installation

```bash
pnpm add -g @b64hub/sfpm-cli
```

npm and yarn work too:

```bash
npm install -g @b64hub/sfpm-cli
yarn global add @b64hub/sfpm-cli
```

Verify the install:

```bash
sfpm --version
```

Run `sfpm --help` for the current command reference — this changes frequently during the beta, so the CLI itself is the source of truth rather than this README.

## Contributing from source

```bash
git clone https://github.com/b64hub/sfpm.git
cd sfpm
pnpm install
pnpm build
pnpm test
```

Useful scripts: `pnpm watch` (rebuild on change), `pnpm typecheck`, `pnpm lint`, `pnpm format`.

## Contributing

Issues and pull requests are welcome at <https://github.com/b64hub/sfpm/issues>.

- Open an issue before starting non-trivial changes, so the approach can be discussed first.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint + Husky).
- Run `pnpm lint && pnpm typecheck && pnpm test` before pushing.

This project is early and actively evolving — feedback on rough edges, missing features, and unclear behavior is exactly what a beta is for.

## License

[MIT](LICENSE)