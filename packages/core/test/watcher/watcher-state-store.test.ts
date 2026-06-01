import fs from 'node:fs';
import path from 'node:path';

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import type {WatcherState} from '../../src/types/watcher.js';
import {WatcherStateStore} from '../../src/watcher/watcher-state-store.js';

describe('WatcherStateStore', () => {
  let store: WatcherStateStore;
  let tmpDir: string;

  function makeState(overrides: Partial<WatcherState> = {}): WatcherState {
    return {
      auth: {username: 'test@example.com'},
      createdAt: Date.now(),
      jobType: 'build',
      payload: {targets: []},
      projectDir: tmpDir,
      updatedAt: Date.now(),
      watcherStatus: 'starting',
      ...overrides,
    };
  }

  beforeEach(async () => {
    tmpDir = path.join(import.meta.dirname, '.test-watchers-' + Math.random().toString(36).slice(2, 8));
    await fs.promises.mkdir(tmpDir, {recursive: true});
    store = new WatcherStateStore(tmpDir);
  });

  afterEach(async () => {
    await fs.promises.rm(tmpDir, {recursive: true, force: true});
  });

  describe('save and load', () => {
    it('should save state and return an ID', async () => {
      const state = makeState();
      const id = await store.save(state);

      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(fs.existsSync(store.getFilePath(id))).toBe(true);
    });

    it('should load a saved state by ID', async () => {
      const state = makeState({jobType: 'deploy'});
      const id = await store.save(state);

      const loaded = await store.load(id);
      expect(loaded).not.toBeNull();
      expect(loaded!.jobType).toBe('deploy');
      expect(loaded!.auth.username).toBe('test@example.com');
    });

    it('should return null for non-existent ID', async () => {
      const loaded = await store.load('does-not-exist');
      expect(loaded).toBeNull();
    });

    it('should return null for invalid JSON', async () => {
      const dir = path.join(tmpDir, '.sfpm/watchers');
      await fs.promises.mkdir(dir, {recursive: true});
      await fs.promises.writeFile(path.join(dir, 'bad.json'), 'not json', 'utf8');

      const loaded = await store.load('bad');
      expect(loaded).toBeNull();
    });
  });

  describe('list', () => {
    it('should return empty array when no watchers exist', async () => {
      const entries = await store.list();
      expect(entries).toEqual([]);
    });

    it('should list all saved watchers sorted by createdAt desc', async () => {
      const older = makeState({createdAt: 1000});
      const newer = makeState({createdAt: 2000});

      await store.save(older);
      await store.save(newer);

      const entries = await store.list();
      expect(entries).toHaveLength(2);
      expect(entries[0].state.createdAt).toBe(2000);
      expect(entries[1].state.createdAt).toBe(1000);
    });

    it('should filter by job type', async () => {
      await store.save(makeState({jobType: 'build'}));
      await store.save(makeState({jobType: 'deploy'}));
      await store.save(makeState({jobType: 'test'}));

      const builds = await store.list('build');
      expect(builds).toHaveLength(1);
      expect(builds[0].state.jobType).toBe('build');
    });
  });

  describe('update', () => {
    it('should update an existing state', async () => {
      const state = makeState({watcherStatus: 'starting'});
      const id = await store.save(state);

      state.watcherStatus = 'polling';
      state.watcherPid = 12345;
      await store.update(id, state);

      const loaded = await store.load(id);
      expect(loaded!.watcherStatus).toBe('polling');
      expect(loaded!.watcherPid).toBe(12345);
    });

    it('should set updatedAt on update', async () => {
      const state = makeState({updatedAt: 1000});
      const id = await store.save(state);

      await store.update(id, state);

      const loaded = await store.load(id);
      expect(loaded!.updatedAt).toBeGreaterThan(1000);
    });
  });

  describe('remove', () => {
    it('should remove a state file', async () => {
      const id = await store.save(makeState());
      expect(fs.existsSync(store.getFilePath(id))).toBe(true);

      await store.remove(id);
      expect(fs.existsSync(store.getFilePath(id))).toBe(false);
    });

    it('should not throw when removing non-existent ID', async () => {
      await expect(store.remove('nope')).resolves.not.toThrow();
    });
  });

  describe('removeStale', () => {
    it('should remove completed and error entries', async () => {
      await store.save(makeState({watcherStatus: 'completed'}));
      await store.save(makeState({watcherStatus: 'error'}));
      await store.save(makeState({watcherStatus: 'polling', watcherPid: process.pid}));

      const removed = await store.removeStale();

      // completed + error removed; polling with live PID kept
      expect(removed).toBe(2);
      const remaining = await store.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].state.watcherStatus).toBe('polling');
    });

    it('should remove orphaned watchers (dead PID)', async () => {
      // Use a PID that's almost certainly not running
      await store.save(makeState({watcherStatus: 'polling', watcherPid: 999999}));

      const removed = await store.removeStale();
      expect(removed).toBe(1);
    });

    it('should filter stale removal by job type', async () => {
      await store.save(makeState({jobType: 'build', watcherStatus: 'completed'}));
      await store.save(makeState({jobType: 'deploy', watcherStatus: 'completed'}));

      const removed = await store.removeStale('build');
      expect(removed).toBe(1);

      const remaining = await store.list();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].state.jobType).toBe('deploy');
    });
  });

  describe('getFilePath', () => {
    it('should prevent path traversal', () => {
      const filePath = store.getFilePath('../../etc/passwd');
      expect(filePath).not.toContain('../../');
      expect(path.basename(filePath)).toBe('passwd.json');
    });
  });
});
