import {
  beforeEach, describe, expect, it, vi,
} from 'vitest';

import {readLatestPackageVersionTags, resolveLatestPackageVersionTags} from '../../src/release/tag-resolver.js';

describe('resolveLatestPackageVersionTags', () => {
  it('parses unscoped package tags correctly', () => {
    const tags = ['my-pkg@1.0.0', 'my-pkg@2.0.0', 'other-pkg@1.5.0'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('my-pkg')).toBe('2.0.0');
    expect(result.get('other-pkg')).toBe('1.5.0');
    expect(result.size).toBe(2);
  });

  it('handles scoped package names and splits on the last @', () => {
    const tags = ['@org/pkg@1.0.0', '@org/pkg@1.5.0', '@scope/other@2.0.0'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('@org/pkg')).toBe('1.5.0');
    expect(result.get('@scope/other')).toBe('2.0.0');
    expect(result.size).toBe(2);
  });

  it('applies semver precedence correctly', () => {
    const tags = ['pkg@1.0.0', 'pkg@1.2.0', 'pkg@1.1.0', 'pkg@2.0.0-beta.1', 'pkg@2.0.0'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('2.0.0');
    expect(result.size).toBe(1);
  });

  it('keeps prerelease versions when they are the highest semver', () => {
    const tags = ['pkg@1.0.0', 'pkg@2.0.0-beta.1', 'pkg@2.0.0-beta.2'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('2.0.0-beta.2');
  });

  it('handles prerelease precedence (prerelease lower than release)', () => {
    const tags = ['pkg@1.0.0', 'pkg@2.0.0-beta.1', 'pkg@2.0.0'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('2.0.0');
  });

  it('drops plain non-semver refs silently', () => {
    const tags = ['latest', 'summer-release-candidate', 'pkg@1.0.0', 'v-tag', 'pkg@2.0.0'];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('2.0.0');
    expect(result.has('latest')).toBe(false);
    expect(result.has('summer-release-candidate')).toBe(false);
    expect(result.size).toBe(1);
  });

  it('ignores malformed tags silently', () => {
    const tags = ['@', 'pkg-no-version', 'pkg@', 'pkg@1.0.0', ''];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('1.0.0');
    expect(result.size).toBe(1);
  });

  it('returns an empty map for an empty tag list', () => {
    const result = resolveLatestPackageVersionTags([]);
    expect(result.size).toBe(0);
  });

  it('handles whitespace in tag lines gracefully', () => {
    const tags = ['  pkg@1.0.0  ', '\tpkg@2.0.0\t', '  ', ''];
    const result = resolveLatestPackageVersionTags(tags);

    expect(result.get('pkg')).toBe('2.0.0');
    expect(result.size).toBe(1);
  });

  it('does not throw on garbage lines', () => {
    const tags = ['pkg@1.0.0', 'not a tag at all!', 'pkg@2.0.0', '!!!', 'pkg@1.5.0'];
    expect(() => resolveLatestPackageVersionTags(tags)).not.toThrow();

    const result = resolveLatestPackageVersionTags(tags);
    expect(result.get('pkg')).toBe('2.0.0');
  });
});

// eslint-disable-next-line mocha/max-top-level-suites
describe('readLatestPackageVersionTags', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockGit: any;

  beforeEach(() => {
    mockGit = {
      tag: vi.fn(),
    };
  });

  it('calls git.tag with --merged flag and resolves the result', async () => {
    mockGit.tag.mockResolvedValue(['@org/pkg@1.0.0', '@org/pkg@2.0.0', 'other@1.5.0']);

    const result = await readLatestPackageVersionTags(mockGit, 'main');

    expect(mockGit.tag).toHaveBeenCalledWith(['--merged', 'main']);
    expect(result.get('@org/pkg')).toBe('2.0.0');
    expect(result.get('other')).toBe('1.5.0');
  });

  it('throws an error with a helpful message when git.tag fails', async () => {
    mockGit.tag.mockRejectedValue(new Error('fatal: ambiguous argument'));

    await expect(readLatestPackageVersionTags(mockGit, 'nonexistent-ref')).rejects.toThrow(/Failed to read git tags merged into "nonexistent-ref"/);
  });

  it('wraps non-Error rejection reasons', async () => {
    mockGit.tag.mockRejectedValue('unknown error');

    await expect(readLatestPackageVersionTags(mockGit, 'main')).rejects.toThrow(/Failed to read git tags merged into "main"/);
  });

  it('suggests shallow clone fix in error message', async () => {
    mockGit.tag.mockRejectedValue(new Error('ref not found'));

    await expect(readLatestPackageVersionTags(mockGit, 'main')).rejects.toThrow(/shallow CI clone may need.*git fetch --tags --unshallow/);
  });
});
