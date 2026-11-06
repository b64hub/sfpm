import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach, beforeEach, describe, expect, it,
} from 'vitest';

import {WorkspaceInitializer} from '../../src/project/workspace-init.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readTurbo(dir: string): {tasks: Record<string, Record<string, unknown>>} {
  return JSON.parse(fs.readFileSync(path.join(dir, 'turbo.json'), 'utf8'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WorkspaceInitializer.scaffold turbo.json', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpm-init-'));
  });

  afterEach(() => {
    fs.rmSync(dir, {force: true, recursive: true});
  });

  it('generates sfpm:deploy as non-cacheable so Turbo never skips a deploy', async () => {
    await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

    const deploy = readTurbo(dir).tasks['sfpm:deploy'];
    expect(deploy.cache).toBe(false);
    expect(deploy.inputs).toBeUndefined();
    expect(deploy.outputs).toBeUndefined();
  });

  it('keeps sfpm:install non-cacheable and sfpm:build cacheable', async () => {
    await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

    const {tasks} = readTurbo(dir);
    expect(tasks['sfpm:install'].cache).toBe(false);
    expect(tasks['sfpm:build'].cache).toBe(true);
  });

  it('overwrites an existing cacheable sfpm:deploy and preserves other tasks', async () => {
    fs.writeFileSync(
      path.join(dir, 'turbo.json'),
      JSON.stringify({tasks: {custom: {cache: true}, 'sfpm:deploy': {cache: true, outputs: []}}}),
      'utf8',
    );

    const result = await new WorkspaceInitializer().scaffold({npmScope: '@myorg', projectDir: dir});

    const {tasks} = readTurbo(dir);
    expect(tasks['sfpm:deploy'].cache).toBe(false);
    expect(tasks.custom).toEqual({cache: true});
    expect(result.modified).toContain('turbo.json');
  });
});
