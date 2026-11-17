import { Platform } from 'obsidian';

/** Watch the desktop vault without loading Node modules on mobile. */
export function watchVaultDisk(
  root: string,
  accept: (path: string) => boolean,
  queue: (path: string) => void,
  onError: (error: unknown) => void,
): () => void {
  if (!Platform.isDesktop) throw new Error('Disk watching requires Obsidian desktop');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Load through Obsidian's desktop CommonJS loader.
  const fs = require('fs') as typeof import('fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, no-undef -- Load through Obsidian's desktop CommonJS loader.
  const path = require('path') as typeof import('path');
  let closed = false;
  const base = fs.realpathSync(root);

  async function inspect(relative: string, scanDirectory: boolean): Promise<void> {
    if (closed || !accept(relative)) return;
    const absolute = path.join(base, relative);
    try {
      const stat = await fs.promises.lstat(absolute);
      if (!stat.isFile() && !stat.isDirectory()) return;
      const canonical = path.relative(base, await fs.promises.realpath(absolute));
      if (canonical.split(path.sep).join('/') !== relative || closed) return;
      if (stat.isFile()) queue(relative);
      else if (scanDirectory) {
        for (const entry of await fs.promises.readdir(absolute)) {
          await inspect(`${relative}/${entry}`, true);
        }
      }
    } catch (error) {
      // Atomic saves often create and immediately rename a temporary file.
      if (!closed && !['ENOENT', 'ENOTDIR'].includes((error as { code?: string }).code ?? '')) onError(error);
    }
  }

  const watcher = fs.watch(base, { recursive: true }, (event, filename) => {
    if (!filename) return;
    const relative = filename.split(path.sep).join('/');
    if (path.isAbsolute(filename) || relative.includes('\\') || relative.split('/').some(part => !part || part === '.' || part === '..')) return;
    void inspect(relative, event === 'rename');
  });
  watcher.on('error', onError);
  return () => { closed = true; watcher.close(); };
}
