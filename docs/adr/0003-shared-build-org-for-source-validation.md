# Shared build org for source package validation

Source packages are validated by deploying to a single shared build org per orchestration run, rather than provisioning an isolated scratch org per package. All packages deploy in dependency-graph order (parallel where independent) to the same org.

We considered per-package isolation, which would catch undeclared dependencies (e.g., package Y compiles only because X happens to be deployed first, even though Y doesn't declare X as a dependency). However, this would consume one scratch org per package per build — unsustainable given Salesforce's scratch org limits (typically 40-200 active orgs per DevHub). The dependency graph already enforces deployment order, and undeclared dependency detection is better addressed through static analysis of the project graph rather than runtime isolation.

## Consequences

- Undeclared transitive dependencies between project packages will not be caught during validation. This is accepted as a known gap.
- Coverage is measured per-package (via `RunSpecifiedTests` with each package's own test classes), not org-wide, so coverage numbers remain meaningful despite the shared environment.
- Hash-based skipping (`SfpmArtifact__c` checksums) works reliably because all packages share the same org state.
