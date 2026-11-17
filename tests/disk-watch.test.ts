import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { Platform } from 'obsidian';
import { watchVaultDisk } from '../src/disk-watch';

test('desktop watcher sees external edits and notes moved into the vault', async () => {
  Object.assign(Platform, { isDesktop: true });
  const root = await mkdtemp(join(tmpdir(), 'gdsync-watch-'));
  const vault = join(root, 'vault');
  await mkdir(vault);
  await mkdir(join(vault, '.obsidian'));
  await mkdir(join(root, 'incoming'));
  await writeFile(join(root, 'incoming', 'new.md'), 'new');
  await writeFile(join(vault, 'note.md'), 'old');
  const queued = new Set<string>();
  const errors: unknown[] = [];
  const close = watchVaultDisk(vault, path => !path.startsWith('.'), path => queued.add(path), e => errors.push(e));
  try {
    await writeFile(join(vault, 'note.md'), 'new');
    await writeFile(join(vault, '.obsidian', 'data.json'), '{}');
    await rename(join(root, 'incoming'), join(vault, 'incoming'));
    for (let attempts = 0; queued.size < 2 && attempts < 60; attempts++) await delay(25);
    assert.deepEqual(errors, []);
    assert.deepEqual([...queued].sort(), ['incoming/new.md', 'note.md']);
  } finally {
    close();
    await rm(root, { recursive: true });
  }
});
