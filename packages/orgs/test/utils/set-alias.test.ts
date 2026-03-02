import {beforeEach, describe, expect, it, vi} from 'vitest';

import {StateAggregator} from '@salesforce/core';

import setAlias from '../../src/utils/set-alias.js';

vi.mock('@salesforce/core', () => ({
  StateAggregator: {
    getInstance: vi.fn(),
  },
}));

describe('setAlias', () => {
  const mockSetAndSave = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(StateAggregator.getInstance).mockResolvedValue({
      aliases: {setAndSave: mockSetAndSave},
    } as unknown as StateAggregator);
  });

  it('should call StateAggregator.getInstance', async () => {
    await setAlias('user@test.org', 'myAlias');
    expect(StateAggregator.getInstance).toHaveBeenCalledOnce();
  });

  it('should set and save the alias with correct arguments', async () => {
    await setAlias('user@test.org', 'myAlias');
    expect(mockSetAndSave).toHaveBeenCalledWith('myAlias', 'user@test.org');
  });

  it('should propagate errors from StateAggregator', async () => {
    vi.mocked(StateAggregator.getInstance).mockRejectedValue(new Error('File system error'));
    await expect(setAlias('user@test.org', 'alias')).rejects.toThrow('File system error');
  });

  it('should propagate errors from setAndSave', async () => {
    mockSetAndSave.mockRejectedValue(new Error('Write failed'));
    await expect(setAlias('user@test.org', 'alias')).rejects.toThrow('Write failed');
  });
});
