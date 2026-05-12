import {describe, expect, it} from 'vitest';

import {extractScope, stripScope} from '../../src/utils/scope-utils.js';

describe('stripScope', () => {
  it('strips scope from scoped package name', () => {
    expect(stripScope('@myorg/core-package')).toBe('core-package');
  });

  it('returns unscoped name unchanged', () => {
    expect(stripScope('core-package')).toBe('core-package');
  });

  it('handles empty string', () => {
    expect(stripScope('')).toBe('');
  });

  it('handles single-character scope', () => {
    expect(stripScope('@a/pkg')).toBe('pkg');
  });

  it('handles scope with dots', () => {
    expect(stripScope('@my.org/core-package')).toBe('core-package');
  });
});

describe('extractScope', () => {
  it('extracts scope from scoped package name', () => {
    expect(extractScope('@myorg/core-package')).toBe('@myorg');
  });

  it('returns undefined for unscoped name', () => {
    expect(extractScope('core-package')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractScope('')).toBeUndefined();
  });

  it('handles scope with hyphens', () => {
    expect(extractScope('@my-org/pkg')).toBe('@my-org');
  });
});
