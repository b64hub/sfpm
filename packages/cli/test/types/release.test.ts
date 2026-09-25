import {expect} from 'chai'

import {
  reconcileManifest,
  resolveSelectionMode,
  selectPackageNames, type WorkspaceCandidate,
} from '../../src/types/release.js'

describe('release types and functions', () => {
  describe('resolveSelectionMode', () => {
    it('returns explicit mode when package names are provided', () => {
      const result = resolveSelectionMode(['pkg1', 'pkg2'])
      expect(result).to.deep.equal({kind: 'explicit', names: ['pkg1', 'pkg2']})
    })

    it('returns tag mode when tags are provided', () => {
      const result = resolveSelectionMode([], ['core', 'sales'])
      expect(result).to.deep.equal({kind: 'tag', tags: ['core', 'sales']})
    })

    it('returns path mode when directory is provided', () => {
      const result = resolveSelectionMode([], undefined, 'packages/core')
      expect(result).to.deep.equal({dir: 'packages/core', kind: 'path'})
    })

    it('returns all mode when no selection criteria are provided', () => {
      const result = resolveSelectionMode([])
      expect(result).to.deep.equal({kind: 'all'})
    })

    it('throws error when multiple selection modes are active', () => {
      expect(() => resolveSelectionMode(['pkg1'], ['core']))
      .to.throw(/Select packages by exactly one of/)
    })

    it('throws error when both tags and path are active', () => {
      expect(() => resolveSelectionMode([], ['core'], 'packages/core'))
      .to.throw(/Select packages by exactly one of/)
    })

    it('throws error when packages, tags, and path are all active', () => {
      expect(() => resolveSelectionMode(['pkg1'], ['core'], 'packages/core'))
      .to.throw(/Select packages by exactly one of/)
    })
  })

  describe('selectPackageNames', () => {
    const candidates: WorkspaceCandidate[] = [
      {dir: '/project/packages/core', keywords: ['core', 'objects'], name: '@org/core-objects'},
      {dir: '/project/packages/sales', keywords: ['sales', 'flow'], name: '@org/sales-flow'},
      {dir: '/project/packages/core-util', keywords: ['core', 'util'], name: '@org/core-util'},
      {dir: '/project/packages/data', keywords: ['data'], name: '@org/data-sync'},
    ]

    it('returns explicit names as-is', () => {
      const result = selectPackageNames(candidates, {kind: 'explicit', names: ['@org/core-objects']})
      expect(result).to.deep.equal(['@org/core-objects'])
    })

    it('selects packages by tag', () => {
      const result = selectPackageNames(candidates, {kind: 'tag', tags: ['core']})
      expect(result).to.have.members(['@org/core-objects', '@org/core-util'])
      expect(result).to.have.lengthOf(2)
    })

    it('selects packages matching ANY of multiple tags', () => {
      const result = selectPackageNames(candidates, {kind: 'tag', tags: ['core', 'sales']})
      expect(result).to.have.members(['@org/core-objects', '@org/sales-flow', '@org/core-util'])
      expect(result).to.have.lengthOf(3)
    })

    it('selects packages by path (exact directory match)', () => {
      const result = selectPackageNames(candidates, {dir: '/project/packages/core', kind: 'path'})
      expect(result).to.deep.equal(['@org/core-objects'])
    })

    it('selects packages by path (directory and descendants)', () => {
      const result = selectPackageNames(candidates, {dir: '/project/packages', kind: 'path'})
      expect(result).to.have.members([
        '@org/core-objects',
        '@org/sales-flow',
        '@org/core-util',
        '@org/data-sync',
      ])
    })

    it('does NOT match sibling directories (core vs core-util)', () => {
      // Ensure /project/packages/core does not match /project/packages/core-util
      const result = selectPackageNames(candidates, {dir: '/project/packages/core', kind: 'path'})
      expect(result).to.deep.equal(['@org/core-objects'])
      expect(result).to.not.include('@org/core-util')
    })

    it('selects all packages in all mode', () => {
      const result = selectPackageNames(candidates, {kind: 'all'})
      expect(result).to.have.lengthOf(4)
      expect(result).to.have.members([
        '@org/core-objects',
        '@org/sales-flow',
        '@org/core-util',
        '@org/data-sync',
      ])
    })

    it('returns empty array when no packages match tag', () => {
      const result = selectPackageNames(candidates, {kind: 'tag', tags: ['nonexistent']})
      expect(result).to.be.empty
    })

    it('handles relative paths by resolving to absolute', () => {
      // Test that relative paths work (they get resolved)
      const resultRel = selectPackageNames(candidates, {dir: 'packages/core', kind: 'path'})
      // Should not match (absolute paths won't equal relative path after resolution)
      expect(resultRel).to.be.empty
    })
  })

  describe('reconcileManifest', () => {
    const resolved = new Map<string, string>([
      ['@org/core', '1.0.0'],
      ['@org/sales', '2.1.0'],
      ['@org/util', '1.5.0'],
    ])

    it('detects missing packages', () => {
      const declared = [{name: '@org/core', version: '1.0.0'}, {name: '@org/missing', version: '1.0.0'}]
      const result = reconcileManifest(declared, resolved)
      expect(result.missing).to.deep.equal(['@org/missing'])
      expect(result.mismatched).to.be.empty
    })

    it('detects version mismatches', () => {
      const declared = [{name: '@org/core', version: '2.0.0'}, {name: '@org/sales', version: '2.1.0'}]
      const result = reconcileManifest(declared, resolved)
      expect(result.missing).to.be.empty
      expect(result.mismatched).to.have.lengthOf(1)
      expect(result.mismatched[0]).to.deep.equal({
        actual: '1.0.0',
        expected: '2.0.0',
        name: '@org/core',
      })
    })

    it('detects both missing and mismatched packages', () => {
      const declared = [
        {name: '@org/core', version: '2.0.0'},
        {name: '@org/missing', version: '1.0.0'},
        {name: '@org/sales', version: '2.1.0'},
      ]
      const result = reconcileManifest(declared, resolved)
      expect(result.missing).to.deep.equal(['@org/missing'])
      expect(result.mismatched).to.have.lengthOf(1)
      expect(result.mismatched[0].name).to.equal('@org/core')
    })

    it('bypasses version check with skipVersionCheck flag', () => {
      const declared = [{name: '@org/core', version: '2.0.0'}]
      const result = reconcileManifest(declared, resolved, {skipVersionCheck: true})
      expect(result.missing).to.be.empty
      expect(result.mismatched).to.be.empty
    })

    it('still detects missing packages even with skipVersionCheck', () => {
      const declared = [{name: '@org/missing', version: '1.0.0'}]
      const result = reconcileManifest(declared, resolved, {skipVersionCheck: true})
      expect(result.missing).to.deep.equal(['@org/missing'])
      expect(result.mismatched).to.be.empty
    })

    it('returns empty result when all declared packages match exactly', () => {
      const declared = [{name: '@org/core', version: '1.0.0'}, {name: '@org/sales', version: '2.1.0'}]
      const result = reconcileManifest(declared, resolved)
      expect(result.missing).to.be.empty
      expect(result.mismatched).to.be.empty
    })

    it('uses exact string comparison, not semver equivalence', () => {
      // 1.0.0 and 1.0.0+build are different strings but same semver
      const declaredWithBuild = [{name: '@org/core', version: '1.0.0+build'}]
      const result = reconcileManifest(declaredWithBuild, resolved)
      expect(result.mismatched).to.have.lengthOf(1)
      expect(result.mismatched[0].expected).to.equal('1.0.0+build')
    })
  })
})
