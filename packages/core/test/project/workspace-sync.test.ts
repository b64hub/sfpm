import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {WorkspaceSync} from '../../src/project/workspace-sync.js';

function writeJson(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

describe('WorkspaceSync namespace', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfpm-sync-'));
    writeJson(path.join(tmp, 'package.json'), {name: 'root', private: true, workspaces: ['packages/a', 'packages/b']});
    for (const name of ['a', 'b']) {
      writeJson(path.join(tmp, 'packages', name, 'package.json'), {
        name: `@x/${name}`,
        sfpm: {packageType: 'unlocked'},
        version: '1.0.0',
      });
    }
  });

  afterEach(() => {
    fs.rmSync(tmp, {force: true, recursive: true});
  });

  it('writes config namespace to root sfdx-project.json', async () => {
    await new WorkspaceSync({namespace: 'myns', projectDir: tmp}).run();
    const sfdx = JSON.parse(fs.readFileSync(path.join(tmp, 'sfdx-project.json'), 'utf8'));
    expect(sfdx.namespace).toBe('myns');
  });

  it('omits namespace from sfdx-project.json when not configured', async () => {
    await new WorkspaceSync({projectDir: tmp}).run();
    const sfdx = JSON.parse(fs.readFileSync(path.join(tmp, 'sfdx-project.json'), 'utf8'));
    expect(sfdx).not.toHaveProperty('namespace');
  });
});
