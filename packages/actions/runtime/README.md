# Action runtime (pinned)

Shared, pinned dependency tree for every SFPM composite action. Each
`action.yml` installs it and runs the `sfpm-action` dispatcher from it:

```bash
npm ci --prefix "$GITHUB_ACTION_PATH/../runtime" --ignore-scripts
"$GITHUB_ACTION_PATH/../runtime/node_modules/.bin/sfpm-action" <action-name>
```

## Why this is separate from `../package.json`

`../package.json` declares *this repository's* `@b64hub/sfpm-actions` package:
it uses pnpm's `workspace:` protocol and cannot be locked by npm
(`EUNSUPPORTEDPROTOCOL`). This directory is a plain **consumer** of the
*published* package, so npm can resolve and lock it. A package cannot depend
on itself, so the two manifests can't be merged.

The repository's root `pnpm-lock.yaml` pins a different tree — the development
and build toolchain. This lockfile pins only what the actions execute.

## Why the lockfile is committed

`package-lock.json` freezes the entire transitive tree to exact versions, and
`npm ci` verifies the SHA-512 integrity hash of every tarball it downloads. A
given tag therefore always installs the same bytes, and the pin set is
reviewable as a normal diff.

A published `npm-shrinkwrap.json` does *not* work for this: npm only honours a
lockfile at the root of an install, never one nested inside a dependency.

## Maintenance

Do not edit by hand. The version can only be pinned once it is published, so
`release.yml` repins after publishing and commits the result before tagging:

```bash
node scripts/sync-action-runtime.mjs --version X.Y.Z   # repin + regenerate
node scripts/sync-action-runtime.mjs --check           # CI: lockfile matches manifest
```
