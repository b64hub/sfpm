import {expect} from 'chai'

import {
  BOOTSTRAP_PACKAGES,
  type BootstrapPackageConfig,
  BootstrapTier,
  getPackagesForTier,
} from '../../src/types/bootstrap.js'

describe('bootstrap types', () => {
  describe('BOOTSTRAP_PACKAGES', () => {
    it('has exactly 3 packages', () => {
      expect(BOOTSTRAP_PACKAGES).to.have.lengthOf(3)
    })

    it('includes sfpm-artifact, sfpm-orgs, and sfpm-ui', () => {
      const names = BOOTSTRAP_PACKAGES.map(p => p.name)
      expect(names).to.include('@b64/sfpm-artifact')
      expect(names).to.include('@b64/sfpm-orgs')
      expect(names).to.include('@b64/sfpm-ui')
    })

    it('each package has required fields', () => {
      for (const pkg of BOOTSTRAP_PACKAGES) {
        expect(pkg.path).to.be.a('string').and.not.be.empty
        expect(pkg.description).to.be.a('string').and.not.be.empty
        expect(pkg.dependencies).to.be.an('array')
        expect(pkg.isOrgDependent).to.be.a('boolean')
      }
    })
  })

  describe('getPackagesForTier', () => {
    it('Core tier returns 1 package', () => {
      expect(getPackagesForTier(BootstrapTier.Core)).to.have.lengthOf(1)
    })

    it('Pool tier returns 2 packages', () => {
      expect(getPackagesForTier(BootstrapTier.Pool)).to.have.lengthOf(2)
    })

    it('Full tier returns 3 packages', () => {
      expect(getPackagesForTier(BootstrapTier.Full)).to.have.lengthOf(3)
    })

    it('tiers are subsets: Core ⊂ Pool ⊂ Full', () => {
      const core = getPackagesForTier(BootstrapTier.Core).map(p => p.name)
      const pool = getPackagesForTier(BootstrapTier.Pool).map(p => p.name)
      const full = getPackagesForTier(BootstrapTier.Full).map(p => p.name)

      // Every core package is in pool
      for (const name of core) {
        expect(pool).to.include(name)
      }

      // Every pool package is in full
      for (const name of pool) {
        expect(full).to.include(name)
      }
    })
  })
})
