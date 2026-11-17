import { FOLDER_MIME, type DriveChange, type RemoteFile, type RemoteTree } from "./drive";

export interface DriveIndex {
  key: string;
  cursor: string;
  folders: [string, string][];
  files: Record<string, RemoteFile>;
  paths: Record<string, string>;
}

export function buildDriveIndex(key: string, cursor: string, tree: RemoteTree): DriveIndex {
  return {
    key, cursor, folders: [...tree.folders],
    files: Object.fromEntries(tree.files),
    paths: Object.fromEntries([...tree.files].map(([path, file]) => [file.id, path])),
  };
}

/** Plan changes without moving the saved cursor until the file queue succeeds. */
export function planDriveChanges(index: DriveIndex, changes: DriveChange[], localPaths: Iterable<string>) {
  const foldersById = new Map(index.folders.map(([path, id]) => [id, path]));
  const affected = new Set(localPaths);
  const updates = new Map<string, RemoteFile | null>();
  for (const [id, change] of new Map(changes.map(change => [change.fileId, change]))) {
    const oldPath = Object.prototype.hasOwnProperty.call(index.paths, id) ? index.paths[id] : undefined;
    const file = change.removed || change.file?.trashed ? undefined : change.file;
    const parents = file?.parents?.filter(id => foldersById.has(id)) ?? [];
    // Directory moves, creations and removals can affect an entire subtree.
    if (foldersById.has(id) || (file?.mimeType === FOLDER_MIME && parents.length)) return null;
    if (!change.removed && !change.file) return null;
    if (oldPath !== undefined && (change.removed || (file && !file.parents))) return null;
    const previous = oldPath === undefined ? undefined : index.files[oldPath];
    // A change page may lag behind a file version this device just uploaded.
    const version = change.file?.version;
    if (version && previous?.version && /^\d+$/.test(version) && /^\d+$/.test(previous.version) &&
      BigInt(version) < BigInt(previous.version)) continue;
    if (oldPath !== undefined) {
      affected.add(oldPath);
      updates.set(oldPath, null);
    }
    if (!file || !parents.length || file.name.startsWith(".") || file.mimeType.startsWith("application/vnd.google-apps.")) continue;
    if (parents.length > 1 || !file.name || /[/\\]/.test(file.name)) return null;
    const parent = foldersById.get(parents[0])!;
    const path = parent ? `${parent}/${file.name}` : file.name;
    const existing = updates.get(path) ?? (Object.prototype.hasOwnProperty.call(index.files, path) ? index.files[path] : undefined);
    if (existing && existing.id !== id) return null;
    affected.add(path);
    updates.set(path, file);
  }
  const files = new Map<string, RemoteFile>();
  for (const path of affected) {
    const file = updates.has(path) ? updates.get(path) : Object.prototype.hasOwnProperty.call(index.files, path) ? index.files[path] : undefined;
    if (file) files.set(path, file);
  }
  return {
    affected,
    tree: { files, folders: new Map(index.folders), warnings: [] } satisfies RemoteTree,
    commit(cursor: string, tree: RemoteTree) {
      for (const path of new Set([...affected, ...tree.files.keys()])) {
        if (Object.prototype.hasOwnProperty.call(index.files, path)) delete index.paths[index.files[path].id];
        delete index.files[path];
      }
      for (const [path, file] of tree.files) {
        Object.defineProperty(index.files, path, { value: file, enumerable: true, configurable: true, writable: true });
        Object.defineProperty(index.paths, file.id, { value: path, enumerable: true, configurable: true, writable: true });
      }
      index.folders = [...tree.folders];
      index.cursor = cursor;
    },
  };
}
