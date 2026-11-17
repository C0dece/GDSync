import type { DataAdapter, Stat } from 'obsidian';
import { assertTransferChunkBytes } from './transfer-settings';

export const LOCAL_READ_CHUNK_SIZE = 1024 * 1024;
export type Snapshot = (Pick<Stat, 'size' | 'mtime' | 'type'> & { sha256?: string }) | null;
export function sameStat(a: Snapshot, b: Snapshot): boolean {
  return a === null ? b === null : b !== null && a.type === b.type && a.size === b.size && a.mtime === b.mtime;
}

export async function assertLocalUnchanged(adapter: DataAdapter, path: string, expected: Snapshot, stage = 'check'): Promise<void> {
  if (expected && expected.type !== 'file') throw new Error('Destination is not a file');
  const actual = await adapter.stat(path);
  if (sameStat(expected, actual)) return;
  console.debug('[GDSync] local snapshot mismatch', { stage, path, expected: expected && { type: expected.type, size: expected.size, mtime: expected.mtime }, actual });
  if (expected?.sha256 && actual?.type === 'file' && expected.size === actual.size) {
    // Import lazily to avoid a module initialization cycle with readLocalChunks.
    const { hashLocalFile } = await import('./checksum');
    const digest = await hashLocalFile(adapter, path);
    const after = await adapter.stat(path);
    console.debug('[GDSync] local hash recheck', { stage, path, actual, after, matches: digest === expected.sha256 });
    if (digest === expected.sha256 && sameStat(actual, after)) return;
  }
  throw new Error('Local file changed during sync; retry sync');
}

export async function* readLocalChunks(adapter: DataAdapter, path: string, chunkSize = LOCAL_READ_CHUNK_SIZE): AsyncGenerator<ArrayBuffer> {
  assertTransferChunkBytes(chunkSize);
  const before = await adapter.stat(path);
  if (!before || before.type !== 'file') throw new Error('Local file is missing');
  // Obsidian's Android adapter uses this resource URL for large binary reads too.
  // Local adapter URL: requestUrl is not a streaming file reader.
  const response = await fetch(adapter.getResourcePath(path), { cache: 'no-store' });
  if (!response.ok || !response.body) throw new Error('Cannot stream local file');
  const reader = response.body.getReader();
  let buffer = new Uint8Array(chunkSize);
  let used = 0;
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > before.size) throw new Error('Local file changed during read');
      let offset = 0;
      while (offset < value.byteLength) {
        if (used === buffer.length) {
          yield buffer.buffer;
          buffer = new Uint8Array(chunkSize);
          used = 0;
        }
        const count = Math.min(buffer.length - used, value.byteLength - offset);
        buffer.set(value.subarray(offset, offset + count), used);
        offset += count;
        used += count;
      }
    }
    if (total !== before.size) throw new Error('Incomplete local file stream');
    await assertLocalUnchanged(adapter, path, before);
    // Hold the final block until size and modification checks have passed.
    if (used) yield used === buffer.length ? buffer.buffer : buffer.slice(0, used).buffer;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
