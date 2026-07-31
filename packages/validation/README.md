# @b64hub/sfpm-validation

Local, best-effort validation for Salesforce package builds via the [Nimbus](https://github.com/nimbus-solution/nimbus) local Apex runtime.

**Not a source of truth.** A real org deployment is the only authoritative signal. This package gives fast, cheap, local feedback — nothing more.

---

## Wiring example

```ts
import {
  createNimbusValidator,
  createNimbusGraphProvider,
  withNimbusDaemon,
  buildOwnershipIndex,
  findPackageBoundaryViolations,
  type NimbusAdapterConfig,
  type ValidationContext,
} from '@b64hub/sfpm-validation';

// 1. Implement Logger and ValidationEventBus structurally (no hard dep on pino)
const logger = pinoLogger.child({ component: 'validation' });
const eventBus = myOrchestratorEventBus; // must have .emit(event, payload)

// 2. Config — ship with daemon off and autoInstall off
const config: NimbusAdapterConfig = {
  pinnedVersion: '1.2.3',           // pin to the version validated against fixtures
  supportedVersionRange: '^1.2.0',
  autoInstall: false,
  daemon: { enabled: false, autoStart: false, autoStop: true },
};

const deps = { logger, eventBus, config };

// 3. Compile / test a single package
const validator = createNimbusValidator(deps);

const ctx: ValidationContext = {
  packageId: 'my-package',
  packagePath: '/project/force-app/my-package',
  projectRoot: '/project',
  timeoutMs: 60_000,
};

const availability = await validator.checkAvailability(ctx);
if (availability.available && availability.compatible !== false) {
  const result = await validator.run('compile', ctx);
  console.log(result.status, result.diagnostics);
}

// 4. Boundary-check a set of packages (optional, requires nimbus graph)
const graphProvider = createNimbusGraphProvider(deps);
const ownershipIndex = buildOwnershipIndex(allPackageManifests);

const violations = await withNimbusDaemon(deps, '/project', () =>
  findPackageBoundaryViolations(myPkg, ownershipIndex, graphProvider, {
    projectRoot: '/project',
    packageId: myPkg.packageId,
  }),
);
```

---

## Default config

```ts
const defaultNimbusConfig: NimbusAdapterConfig = {
  pinnedVersion: '<pin to the version validated against fixtures>',
  supportedVersionRange: '^<same major.minor>',
  autoInstall: false,
  daemon: {
    enabled: false,   // opt-in per-environment; requires Nimbus Pro license
    autoStart: false,
    autoStop: true,
  },
};
```

Ship with `daemon.enabled: false` and `autoInstall: false`. Both are safe to flip per-team once daemon subcommands are confirmed with the Nimbus maintainer and Pro licenses are verified (see Open Questions in the implementation plan).

---

## Open questions (block Phase 6/7 ship)

1. Do `nimbus daemon start` / `nimbus daemon status --json` exist as named? Only `daemon stop` is confirmed.
2. Does a non-zero `daemon start` exit distinguish "no Pro license" from other failures?
3. Does `nimbus graph` support whole-package mode, or only per-class?
4. What does a **failing** `nimbus test --json` test case look like exactly?
5. Does `nimbus validate`/`nimbus test` accept the glob pattern style shown (`*`, class name)?
