import { App, TFile, Platform } from "obsidian";
import { DriveClient, RemoteFile, RemoteTree } from "./drive";
import { GSyncSettings } from "./settings";
import type { TransferProgress } from "./progress";
import { AndroidFiles } from "./android-files";
import { transferChunkBytes } from "./transfer-settings";
import { assertLocalUnchanged, sameStat, Snapshot } from "./local-files";
import { hashLocalFile, sha256Bytes, validSha256 } from "./checksum";
import { sameRemoteVersion } from "./remote-metadata";
import { workspaceFormat } from "./workspace-files";

/** What both sides looked like the last time this path was in sync. */
export interface SyncRecord {
  remoteId: string;
  remoteRev: string;
  localMtime: number;
  localSize: number;
  workspaceDigest?: string;
}
export type SyncState = Record<string, SyncRecord>;
interface LocalEntry {
  stat: Pick<TFile["stat"], "mtime" | "size">;
  file?: TFile;
}

export interface SyncResult {
  uploaded: number;
  downloaded: number;
  deletedLocal: number;
  deletedRemote: number;
  conflicts: string[];
  errors: string[];
  warnings: string[];
  skipped: string[];
  /** Local edits/new files in read-only folders that were not uploaded. */
  readOnlyKept: string[];
}

/** One vault folder <-> one Drive folder. The main pair covers the whole vault (prefix ""). */
export interface SyncScope {
  /** Vault folder this pair covers ("" = whole vault). */
  localPrefix: string;
  /** Drive folder path, e.g. "Obsidian/Notes" or "Shared drives/Company/Notes". */
  remotePath: string;
  /** Vault folders handled by other pairs, which this pair must leave alone. */
  otherPrefixes: string[];
  /** The user can only view this Drive folder: never upload or delete there. */
  readOnly: boolean;
}

export interface SyncHooks {
  /** Persist state mid-sync so a crash doesn't lose finished work. */
  checkpoint: () => Promise<void>;
  transfer?: (progress: TransferProgress) => void;
  progress: (done: number, total: number, transferred: number) => void;
}

const rev = (f: RemoteFile) => f.md5Checksum ?? f.modifiedTime;

function parseExcludes(raw: string): string[] {
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}

function isExcluded(path: string, rules: string[], configDir: string): boolean {
  // Never touch the vault config folder (usually .obsidian, but user-configurable)
  // or any hidden file/folder (.trash, .git ...) on either side.
  if (configDir && (path === configDir || path.startsWith(configDir + "/"))) return true;
  if (path.split("/").some((seg) => seg.startsWith("."))) return true;
  const name = path.split("/").pop() ?? path;
  return rules.some((r) => {
    if (r.startsWith("*.")) return path.toLowerCase().endsWith(r.slice(1).toLowerCase());
    if (r.endsWith("/")) return path.startsWith(r);
    return path === r || name === r || path.startsWith(r + "/");
  });
}

function sameBytes(a: ArrayBuffer, b: ArrayBuffer): boolean {
  if (a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}

function conflictPath(path: string): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const slash = path.lastIndexOf("/");
  const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
  const file = path.slice(slash + 1);
  const dot = file.lastIndexOf(".");
  const base = dot > 0 ? file.slice(0, dot) : file;
  const ext = dot > 0 ? file.slice(dot) : "";
  return `${dir}${base} (conflict ${stamp})${ext}`;
}

export function underPrefix(path: string, prefix: string): boolean {
  return !prefix || path === prefix || path.startsWith(prefix + "/");
}

export async function runSync(
  app: App,
  drive: DriveClient,
  settings: GSyncSettings,
  state: SyncState,
  hooks: SyncHooks,
  scope: SyncScope = { localPrefix: "", remotePath: settings.remoteFolder, otherPrefixes: [], readOnly: false },
  input?: { tree: RemoteTree; paths?: Iterable<string>; diskPaths?: ReadonlySet<string> },
): Promise<SyncResult> {
  const vault = app.vault;
  const res: SyncResult = { uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0, conflicts: [], errors: [], warnings: [], skipped: [], readOnlyKept: [] };
  const prefix = scope.localPrefix.replace(/^\/+|\/+$/g, "");
  const inScope = (path: string) => underPrefix(path, prefix) && !scope.otherPrefixes.some((o) => o && underPrefix(path, o));
  /** Vault path -> path inside the Drive folder. */
  const toRemote = (path: string) => (prefix ? path.slice(prefix.length + 1) : path);
  const toVault = (rel: string) => (prefix ? (rel ? `${prefix}/${rel}` : prefix) : rel);
  const maxBytes = Math.max(0, settings.maxFileSizeMB) * 1024 * 1024;
  const rules = parseExcludes(settings.excludes);
  const configDir = vault.configDir;
  const android = Platform.isAndroidApp ? new AndroidFiles(vault.adapter, configDir) : null;
  if (android) {
    hooks.transfer?.({ phase: 'recovery', path: configDir });
    res.warnings.push(...await android.recover());
  }

  hooks.transfer?.({ phase: 'folder', path: scope.remotePath });
  const rootId = input ? undefined : await drive.ensureFolderPath(scope.remotePath);
  hooks.transfer?.({ phase: 'listing', path: scope.remotePath });
  const listed = input?.tree ?? await drive.listTree(rootId!);
  res.warnings.push(...listed.warnings);
  // Re-key the Drive listing by vault path, so the rest of the engine works in vault paths.
  const tree: RemoteTree = { files: new Map(), folders: new Map(), warnings: listed.warnings };
  for (const [rel, f] of listed.files) tree.files.set(toVault(rel), f);
  for (const [rel, id] of listed.folders) tree.folders.set(toVault(rel), id);

  const local = new Map<string, TFile>();
  const candidates = input?.paths ? [...input.paths].map(rel => vault.getAbstractFileByPath(toVault(rel))) : vault.getFiles();
  for (const f of candidates) if (f instanceof TFile && inScope(f.path) && !isExcluded(f.path, rules, configDir)) local.set(f.path, f);
  const remote = tree.files;
  const verifiedUploads = new Map<string, Snapshot>();

  // ---- helpers ------------------------------------------------------------
  const record = async (path: string, r: RemoteFile, expected?: Snapshot) => {
    expected ??= verifiedUploads.get(path);
    verifiedUploads.delete(path);
    let st = await vault.adapter.stat(path);
    if (expected !== undefined && !sameStat(expected, st)) {
      await assertLocalUnchanged(vault.adapter, path, expected, 'record');
      st = await vault.adapter.stat(path);
      if (!sameStat(expected, st)) await assertLocalUnchanged(vault.adapter, path, expected, 'record-final');
    }
    if (!st) return;
    state[path] = { remoteId: r.id, remoteRev: rev(r), localMtime: st.mtime, localSize: st.size };
  };

  const ensureRemoteParent = async (path: string): Promise<string> => {
    const parts = toRemote(path).split("/").slice(0, -1);
    let cur = prefix;
    let parentId = tree.folders.get(prefix) as string;
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      let id = tree.folders.get(cur);
      if (!id) {
        id = await drive.createFolder(p, parentId);
        tree.folders.set(cur, id);
        listed.folders.set(toRemote(cur), id);
      }
      parentId = id;
    }
    return parentId;
  };

  const ensureLocalParent = async (path: string) => {
    const parts = path.split("/").slice(0, -1);
    let cur = "";
    for (const p of parts) {
      cur = cur ? `${cur}/${p}` : p;
      if (!vault.getAbstractFileByPath(cur)) await vault.createFolder(cur);
    }
  };

  const writeLocal = async (path: string, data: ArrayBuffer, hadLocal = false) => {
    const existing = vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await vault.modifyBinary(existing, data);
    else if (hadLocal) await vault.adapter.writeBinary(path, data);
    else {
      await ensureLocalParent(path);
      await vault.createBinary(path, data);
    }
  };

  const uploadNew = async (path: string, data: ArrayBuffer): Promise<RemoteFile> => {
    if (scope.readOnly) throw new Error("Read-only folder: uploads are not allowed");
    const parentId = await ensureRemoteParent(path);
    const name = path.split("/").pop() as string;
    const created = await drive.createFile(name, parentId, data);
    listed.files.set(toRemote(path), created);
    return created;
  };

  const downloading = (path: string, remote: RemoteFile) => {
    hooks.transfer?.({ phase: "download", path, bytes: 0, total: Number(remote.size) });
    return drive.downloadChunks(remote, (bytes, total) => hooks.transfer?.({ phase: "download", path, bytes, total }), transferChunkBytes(settings.transferChunkSizeMiB));
  };

  const androidSnapshot = (path: string) => android!.snapshot(path,
    (bytes, total) => hooks.transfer?.({ phase: 'snapshot', path, bytes, total }));

  const downloadLocal = async (path: string, remote: RemoteFile, hadLocal: boolean) => {
    const expected = android ? await androidSnapshot(path) : await vault.adapter.stat(path);
    if (hadLocal !== (expected?.type === 'file') || (expected && expected.type !== 'file')) {
      throw new Error('Local file changed during sync; retry sync');
    }
    if (!android) {
      hooks.transfer?.({ phase: "download", path });
      const data = await drive.download(remote.id);
      hooks.transfer?.({ phase: "install", path });
      await assertLocalUnchanged(vault.adapter, path, expected, "install");
      return writeLocal(path, data, hadLocal);
    }
    const staged = await android.stage(downloading(path, remote));
    try {
      hooks.transfer?.({ phase: "install", path });
      await staged.install(path, expected);
    }
    finally { await staged.dispose(); }
  };

  const uploadLocal = async (path: string, remoteId?: string): Promise<RemoteFile> => {
    if (scope.readOnly) throw new Error("Read-only folder: uploads are not allowed");
    if (!android) {
      hooks.transfer?.({ phase: "upload", path });
      const expected = await vault.adapter.stat(path);
      if (!expected || expected.type !== "file") throw new Error("Local file missing");
      const data = await readLocal(path);
      await assertLocalUnchanged(vault.adapter, path, expected, "upload");
      verifiedUploads.set(path, expected);
      if (!remoteId) return uploadNew(path, data);
      const updated = await drive.updateFile(remoteId, data);
      listed.files.set(toRemote(path), updated);
      return updated;
    }
    const expected = await androidSnapshot(path);
    if (!expected) throw new Error("Local file missing");
    const target = remoteId ? { id: remoteId } : {
      name: path.split("/").pop() as string, parentId: await ensureRemoteParent(path),
    };
    await android.assertUnchanged(path, expected);
    const chunkSize = transferChunkBytes(settings.transferChunkSizeMiB);
    const uploaded = await drive.uploadChunks(expected.size, android.readChunks(path, chunkSize), target,
      (bytes, total) => hooks.transfer?.({ phase: "upload", path, bytes, total }), chunkSize);
    listed.files.set(toRemote(path), uploaded);
    await android.assertUnchanged(path, expected);
    verifiedUploads.set(path, expected);
    return uploaded;
  };

  const readLocal = (path: string) => {
    const file = vault.getAbstractFileByPath(path);
    return file instanceof TFile && !input?.diskPaths?.has(path)
      ? vault.readBinary(file)
      : vault.adapter.readBinary(path);
  };
  const localChangedSince = (f: LocalEntry, s: SyncRecord) => f.stat.mtime !== s.localMtime || f.stat.size !== s.localSize;
  const trashLocal = (entry: LocalEntry) => {
    if (!entry.file) throw new Error("Local file is not yet indexed by Obsidian; retry sync");
    return app.fileManager.trashFile(entry.file);
  };

  /** A path that is free both here and in Drive, next to `path`. */
  const freeCopyPath = async (path: string, label: string): Promise<string> => {
    let c = conflictPath(path).replace("(conflict ", `(${label} `);
    while (await vault.adapter.exists(c) || tree.files.has(c)) {
      const suffix = "-" + crypto.randomUUID().slice(0, 8);
      const dot = c.lastIndexOf(".");
      c = dot > c.lastIndexOf("/") ? c.slice(0, dot) + suffix + c.slice(dot) : c + suffix;
    }
    return c;
  };

  const syncWorkspace = async (path: string, remote: RemoteFile, previous?: SyncRecord) => {
    const revision = remote.version ?? remote.modifiedTime;
    const before = await vault.adapter.stat(path);
    if (before && before.type !== 'file') throw new Error('Workspace export destination is a folder');
    if (maxBytes > 0 && before && before.size > maxBytes) { res.skipped.push(path); return; }
    const tracked = previous?.remoteId === remote.id && previous.workspaceDigest;
    if (before && tracked && previous.remoteRev === revision) return;
    hooks.transfer?.({ phase: 'download', path });
    if (!sameRemoteVersion(remote, await drive.getFile(remote.id))) throw new Error('Google document changed before export; retry sync');
    const data = await drive.exportWorkspaceFile(remote);
    if (!sameRemoteVersion(remote, await drive.getFile(remote.id))) throw new Error('Google document changed during export; retry sync');
    if (maxBytes > 0 && data.byteLength > maxBytes) { res.skipped.push(path); return; }

    const digest = sha256Bytes(data);
    const oldDigest = before && (android ? await hashLocalFile(vault.adapter, path) : sha256Bytes(await readLocal(path)));
    await assertLocalUnchanged(vault.adapter, path, before, 'workspace-export');
    if (before && oldDigest !== digest && oldDigest !== tracked) {
      const copy = await freeCopyPath(path, 'local edit');
      await vault.adapter.copy(path, copy);
      await assertLocalUnchanged(vault.adapter, path, before, 'workspace-backup');
      res.readOnlyKept.push(copy);
    }
    if (oldDigest !== digest) {
      hooks.transfer?.({ phase: 'install', path });
      if (android) {
        async function* chunks() {
          const size = transferChunkBytes(1);
          for (let offset = 0; offset < data.byteLength; offset += size) yield data.slice(offset, offset + size);
        }
        const staged = await android.stage(chunks());
        try { await staged.install(path, before && { ...before, sha256: oldDigest || undefined }); }
        finally { await staged.dispose(); }
      } else {
        await assertLocalUnchanged(vault.adapter, path, before, 'workspace-install');
        await writeLocal(path, data, !!before);
      }
      res.downloaded++;
    }
    const saved = await vault.adapter.stat(path);
    if (!saved || saved.type !== 'file' || saved.size !== data.byteLength) throw new Error('Incomplete Workspace export');
    state[path] = { remoteId: remote.id, remoteRev: revision, localMtime: saved.mtime, localSize: saved.size, workspaceDigest: digest };
  };

  /**
   * Read-only folder: Drive is the source of truth. A local edit is kept as a
   * "(local edit …)" copy next to the file, then the Drive version is restored.
   */
  const restoreFromDrive = async (path: string, l: LocalEntry | undefined, r: RemoteFile) => {
    if (l) {
      const copy = await freeCopyPath(path, "local edit");
      await vault.adapter.copy(path, copy);
      res.readOnlyKept.push(copy);
    }
    await downloadLocal(path, r, !!l);
    await record(path, r);
    res.downloaded++;
  };

  const syncReadOnly = async (path: string, l: LocalEntry | undefined, r: RemoteFile | undefined, s: SyncRecord | undefined) => {
    if (l && r) {
      const lChanged = !s || localChangedSince(l, s);
      const rChanged = !s || rev(r) !== s.remoteRev || r.id !== s.remoteId;
      if (!lChanged && !rChanged) return;
      if (!s && validSha256(r.sha256Checksum) && String(l.stat.size) === r.size) {
        const digest = await hashLocalFile(vault.adapter, path,
          bytes => hooks.transfer?.({ phase: "hash", path, bytes, total: l.stat.size }));
        if (digest === r.sha256Checksum.toLowerCase()) { await record(path, r); return; }
      }
      if (lChanged) await restoreFromDrive(path, l, r);
      else { await downloadLocal(path, r, true); await record(path, r); res.downloaded++; }
    } else if (l && !r) {
      if (s && settings.propagateDeletes && !localChangedSince(l, s)) {
        await trashLocal(l); // removed in Drive -> remove here
        delete state[path];
        res.deletedLocal++;
      } else {
        delete state[path];
        res.readOnlyKept.push(path); // new local file: stays on this device only
      }
    } else if (!l && r) {
      await downloadLocal(path, r, false); // also restores files deleted on this device
      await record(path, r);
      res.downloaded++;
    } else {
      delete state[path];
    }
  };

  const resolveBothChanged = async (path: string, r: RemoteFile) => {
    const expected = android ? await androidSnapshot(path) : await vault.adapter.stat(path);
    if (!expected || expected.type !== "file") throw new Error("Local file missing during comparison");
    // Only compare files already matched by their full vault-relative path.
    // A missing/invalid checksum keeps the exact comparison fallback.
    let equal: boolean | undefined;
    const remoteSize = /^\d+$/.test(r.size ?? "") ? Number(r.size) : NaN;
    if (Number.isSafeInteger(remoteSize) && expected.size !== remoteSize) equal = false;
    else if (validSha256(r.sha256Checksum)) {
      const digest = await hashLocalFile(vault.adapter, path,
        bytes => hooks.transfer?.({ phase: "hash", path, bytes, total: expected.size }));
      if (!sameRemoteVersion(r, await drive.getFile(r.id))) throw new Error("Remote file changed during comparison; retry sync");
      await assertLocalUnchanged(vault.adapter, path, expected);
      equal = digest === r.sha256Checksum.toLowerCase();
      if (equal) { await record(path, r, expected); return; }
    }
    if (android) {
      const staged = await android.stage(downloading(path, r));
      try {
        if (equal === undefined) {
          hooks.transfer?.({ phase: "compare", path });
          equal = await android.equal(path, staged.path);
        }
        await android.assertUnchanged(path, expected);
        if (equal) { await record(path, r, expected); return; }
        let cPath = conflictPath(path);
        while (await vault.adapter.exists(cPath) || tree.files.has(cPath)) {
          const suffix = "-" + crypto.randomUUID();
          const dot = cPath.lastIndexOf(".");
          cPath = dot > cPath.lastIndexOf("/") ? cPath.slice(0, dot) + suffix + cPath.slice(dot) : cPath + suffix;
        }
        hooks.transfer?.({ phase: "install", path: cPath });
        await staged.install(cPath, null);
        const cRemote = await uploadLocal(cPath);
        await record(cPath, cRemote);
        await android.assertUnchanged(path, expected);
        const updated = await uploadLocal(path, r.id);
        await record(path, updated);
        res.conflicts.push(path);
        return;
      } finally { await staged.dispose(); }
    }
    hooks.transfer?.({ phase: equal === undefined ? "compare" : "download", path });
    const [ld, rd] = await Promise.all([readLocal(path), drive.download(r.id)]);
    await assertLocalUnchanged(vault.adapter, path, expected);
    if (equal === undefined && sameBytes(ld, rd)) {
      await record(path, r, expected);
      return;
    }
    // Keep both: local wins the original name, Drive's version is saved beside it.
    const cPath = conflictPath(path);
    hooks.transfer?.({ phase: "install", path: cPath });
    await writeLocal(cPath, rd);
    hooks.transfer?.({ phase: "upload", path: cPath });
    const cRemote = await uploadNew(cPath, rd);
    await record(cPath, cRemote);
    hooks.transfer?.({ phase: "upload", path });
    const updated = await drive.updateFile(r.id, ld);
    listed.files.set(toRemote(path), updated);
    await record(path, updated, expected);
    res.conflicts.push(path);
  };

  // ---- main pass ----------------------------------------------------------
  const paths = input?.paths
    ? [...new Set([...input.paths].map(toVault).filter(inScope))].sort()
    : [...new Set([...local.keys(), ...remote.keys(), ...Object.keys(state), ...(input?.diskPaths ?? [])])].filter(inScope).sort();

  const work = () => res.uploaded + res.downloaded + res.deletedLocal + res.deletedRemote + res.conflicts.length;
  let lastCheckpointWork = 0;
  let lastCheckpointAt = Date.now();
  let done = 0;

  for (const path of paths) {
    done++;
    hooks.progress(done - 1, paths.length, work());
    // Save progress every 10 transfers or 5 seconds.
    if (work() - lastCheckpointWork >= 10 || (work() > lastCheckpointWork && Date.now() - lastCheckpointAt > 5000)) {
      await hooks.checkpoint();
      lastCheckpointWork = work();
      lastCheckpointAt = Date.now();
    }
    if (isExcluded(path, rules, configDir)) continue;
    if (android?.blockedPaths.has(path)) {
      res.errors.push(`${path}: interrupted transfer needs recovery before syncing`);
      continue;
    }
    try {
      const file = local.get(path);
      let l: LocalEntry | undefined = file && { file, stat: file.stat };
      if (input?.diskPaths?.has(path)) {
        const stat = await vault.adapter.stat(path);
        l = stat?.type === "file" ? { file, stat } : undefined;
      }
      const r = remote.get(path);
      let s: SyncRecord | undefined = state[path];
      if (r && workspaceFormat(r)) {
        await syncWorkspace(path, r, s);
        continue;
      }
      if (s?.workspaceDigest) {
        if (!r) continue; // Retain exported copies when the source is removed or moved.
        if (l) throw new Error('A regular Drive file uses this export path; move the local export to sync both');
        s = undefined;
      }
      if (maxBytes > 0 && ((l && l.stat.size > maxBytes) || (r && Number(r.size ?? 0) > maxBytes))) {
        res.skipped.push(path);
        continue;
      }

      if (scope.readOnly) {
        await syncReadOnly(path, l, r, s);
        continue;
      }

      if (l && r) {
        if (!s) {
          await resolveBothChanged(path, r); // first time we've seen both: compare contents
          continue;
        }
        const lChanged = localChangedSince(l, s);
        const rChanged = rev(r) !== s.remoteRev || r.id !== s.remoteId;
        if (lChanged && rChanged) await resolveBothChanged(path, r);
        else if (lChanged) {
          const updated = await uploadLocal(path, r.id);
          await record(path, updated);
          res.uploaded++;
        } else if (rChanged) {
          await downloadLocal(path, r, true);
          await record(path, r);
          res.downloaded++;
        }
      } else if (l && !r) {
        if (s && settings.propagateDeletes && !localChangedSince(l, s)) {
          await trashLocal(l); // deleted in Drive -> delete here
          delete state[path];
          res.deletedLocal++;
        } else {
          const created = await uploadLocal(path);
          await record(path, created);
          res.uploaded++;
        }
      } else if (!l && r) {
        if (s && settings.propagateDeletes && rev(r) === s.remoteRev) {
          if (await vault.adapter.stat(path)) throw new Error("Local file is still present; retry sync");
          await drive.trash(r.id); // deleted here -> move to Drive trash
          listed.files.delete(toRemote(path));
          delete state[path];
          res.deletedRemote++;
        } else {
          await downloadLocal(path, r, false);
          await record(path, r);
          res.downloaded++;
        }
      } else {
        delete state[path]; // gone on both sides
      }
    } catch (e) {
      res.errors.push(`${path}: ${(e as Error).message}`);
    }
  }
  hooks.progress(paths.length, paths.length, work());
  return res;
}
