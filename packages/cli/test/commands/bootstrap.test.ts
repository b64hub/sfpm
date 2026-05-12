import {expect} from 'chai'

import {
  BOOTSTRAP_PACKAGES,
  type BootstrapAction,
  BootstrapTier,
  type PackageResolveState,
  getPackagesForTier,
  resolveAction,
} from '../../src/types/bootstrap.js'

// ====================================================================
// Bootstrap decision tree
//
// The bootstrap command resolves a per-package action based on:
//   1. DevHub state: does the Package2 exist? Any versions? Released?
//   2. Target org state: is a version installed? Which one?
//   3. --force flag: overrides all checks
//
// Decision table:
// ┌──────────────────────────────┬───────────────────────┬────────────┐
// │ DevHub state                 │ Target org state      │ Action     │
// ├──────────────────────────────┼───────────────────────┼────────────┤
// │ No Package2                  │ —                     │ build      │
// │ Package2, no versions        │ —                     │ build      │
// │ Package2, unreleased version │ —                     │ promote    │
// │ Package2, released version   │ Not installed         │ install    │
// │ Package2, released version   │ Older version         │ install    │
// │ Package2, released version   │ Same version          │ skip       │
// │ --force (any state)          │ —                     │ build      │
// └──────────────────────────────┴───────────────────────┴────────────┘
//
// Pipeline execution order:
//   1. resolvePackageStatuses() → per-package action
//   2. buildPackages()          → only 'build' packages
//   3. promotePackages()        → 'build' + 'promote' packages
//   4. installPackages()        → 'build' + 'promote' + 'install' packages
//   5. finalizeResult()         → aggregate results
//
// Idempotency guarantees:
//   - Re-running after full success → all packages 'skip'
//   - Re-running after promote failure → 'promote' action (no rebuild)
//   - Re-running after install failure → packages re-attempt install
//   - --force always rebuilds everything
// ====================================================================

/** Helper to build a PackageResolveState with sensible defaults. */
function makeState(overrides: Partial<PackageResolveState> = {}): PackageResolveState {
  return {
    force: false,
    hasPackage: true,
    hasReleasedVersions: true,
    hasUnreleasedVersions: false,
    installedVersion: undefined,
    latestVersion: '1.0.0.1',
    ...overrides,
  }
}

describe('bootstrap', () => {
  // ====================================================================
  // resolveAction — core decision tree
  // ====================================================================

  describe('resolveAction', () => {
    // ── --force flag ──────────────────────────────────────────────
    describe('when --force is set', () => {
      it('returns build regardless of DevHub state', () => {
        expect(resolveAction(makeState({force: true, hasPackage: false}))).to.equal('build')
      })

      it('returns build even when same version is installed', () => {
        expect(resolveAction(makeState({
          force: true,
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.0.1',
        }))).to.equal('build')
      })

      it('returns build when unreleased version exists', () => {
        expect(resolveAction(makeState({
          force: true,
          hasReleasedVersions: false,
          hasUnreleasedVersions: true,
        }))).to.equal('build')
      })
    })

    // ── No Package2 in DevHub ─────────────────────────────────────
    describe('when Package2 does not exist in DevHub', () => {
      it('returns build', () => {
        expect(resolveAction(makeState({
          hasPackage: false,
          hasReleasedVersions: false,
          hasUnreleasedVersions: false,
        }))).to.equal('build')
      })
    })

    // ── No versions at all ────────────────────────────────────────
    describe('when Package2 exists but has no versions', () => {
      it('returns build', () => {
        expect(resolveAction(makeState({
          hasReleasedVersions: false,
          hasUnreleasedVersions: false,
        }))).to.equal('build')
      })
    })

    // ── Unreleased version (built but not promoted) ───────────────
    describe('when unreleased version exists (promote recovery)', () => {
      it('returns promote', () => {
        expect(resolveAction(makeState({
          hasReleasedVersions: false,
          hasUnreleasedVersions: true,
        }))).to.equal('promote')
      })
    })

    // ── Released version, not installed ───────────────────────────
    describe('when released version exists but not installed', () => {
      it('returns install', () => {
        expect(resolveAction(makeState({
          installedVersion: undefined,
          latestVersion: '1.0.0.1',
        }))).to.equal('install')
      })
    })

    // ── Released version, older version installed ─────────────────
    describe('when released version is newer than installed', () => {
      it('returns install', () => {
        expect(resolveAction(makeState({
          installedVersion: '1.0.0.1',
          latestVersion: '2.0.0.1',
        }))).to.equal('install')
      })
    })

    // ── Released version, same version installed ──────────────────
    describe('when same version is already installed', () => {
      it('returns skip', () => {
        expect(resolveAction(makeState({
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.0.1',
        }))).to.equal('skip')
      })
    })

    // ── Idempotency scenarios ─────────────────────────────────────
    describe('idempotency', () => {
      it('complete success re-run: all packages skip', () => {
        // Simulates re-running after everything succeeded — all installed at latest
        const packages = ['@b64/sfpm-artifact', '@b64/sfpm-orgs', '@b64/sfpm-ui']
        const actions = packages.map(() =>
          resolveAction(makeState({installedVersion: '1.0.0.1', latestVersion: '1.0.0.1'})),
        )
        expect(actions).to.deep.equal(['skip', 'skip', 'skip'])
      })

      it('promote failure re-run: promote action (no rebuild)', () => {
        // Built successfully but promote failed — re-run should promote, not rebuild
        expect(resolveAction(makeState({
          hasReleasedVersions: false,
          hasUnreleasedVersions: true,
        }))).to.equal('promote')
      })

      it('install failure re-run: install action', () => {
        // Built and promoted but install failed — re-run should install
        expect(resolveAction(makeState({
          installedVersion: undefined,
          latestVersion: '1.0.0.1',
        }))).to.equal('install')
      })
    })

    // ── Edge cases ────────────────────────────────────────────────
    describe('edge cases', () => {
      it('treats different patch versions as needing install', () => {
        expect(resolveAction(makeState({
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.1.1',
        }))).to.equal('install')
      })

      it('treats different build numbers as needing install', () => {
        expect(resolveAction(makeState({
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.0.2',
        }))).to.equal('install')
      })

      it('force overrides skip', () => {
        const withoutForce = resolveAction(makeState({
          force: false,
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.0.1',
        }))
        const withForce = resolveAction(makeState({
          force: true,
          installedVersion: '1.0.0.1',
          latestVersion: '1.0.0.1',
        }))
        expect(withoutForce).to.equal('skip')
        expect(withForce).to.equal('build')
      })
    })
  })

  // ====================================================================
  // getPackagesForTier
  // ====================================================================

  describe('getPackagesForTier', () => {
    it('Core tier returns only sfpm-artifact', () => {
      const result = getPackagesForTier(BootstrapTier.Core)
      expect(result).to.have.lengthOf(1)
      expect(result[0].name).to.equal('@b64/sfpm-artifact')
    })

    it('Pool tier returns sfpm-artifact and sfpm-orgs', () => {
      const result = getPackagesForTier(BootstrapTier.Pool)
      expect(result).to.have.lengthOf(2)
      const names = result.map(p => p.name)
      expect(names).to.include('@b64/sfpm-artifact')
      expect(names).to.include('@b64/sfpm-orgs')
      expect(names).to.not.include('@b64/sfpm-ui')
    })

    it('Full tier returns all 3 packages', () => {
      const result = getPackagesForTier(BootstrapTier.Full)
      expect(result).to.have.lengthOf(3)
      expect(result).to.deep.equal(BOOTSTRAP_PACKAGES)
    })

    it('Full tier returns a copy, not a reference', () => {
      const result = getPackagesForTier(BootstrapTier.Full)
      expect(result).to.not.equal(BOOTSTRAP_PACKAGES)
    })
  })

  // ====================================================================
  // Package dependency structure
  // ====================================================================

  describe('BOOTSTRAP_PACKAGES dependency structure', () => {
    it('sfpm-artifact is the root (no dependencies)', () => {
      const artifact = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-artifact')!
      expect(artifact.dependencies).to.deep.equal([])
    })

    it('sfpm-orgs depends on sfpm-artifact', () => {
      const orgs = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-orgs')!
      expect(orgs.dependencies).to.deep.equal(['@b64/sfpm-artifact'])
    })

    it('sfpm-ui depends on sfpm-artifact', () => {
      const ui = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-ui')!
      expect(ui.dependencies).to.deep.equal(['@b64/sfpm-artifact'])
    })

    it('sfpm-orgs is org-dependent (sandboxes inherit it)', () => {
      const orgs = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-orgs')!
      expect(orgs.isOrgDependent).to.equal(true)
    })

    it('sfpm-artifact and sfpm-ui are not org-dependent', () => {
      const artifact = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-artifact')!
      const ui = BOOTSTRAP_PACKAGES.find(p => p.name === '@b64/sfpm-ui')!
      expect(artifact.isOrgDependent).to.equal(false)
      expect(ui.isOrgDependent).to.equal(false)
    })
  })
})
