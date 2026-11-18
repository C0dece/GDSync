import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Platform, TFile } from 'obsidian';
import { runSync, SyncState } from '../src/sync';
import { configCategory, DEFAULT_CONFIG_SYNC, mergePluginLists, localPlugins, runConfigSync } from '../src/config-sync';
import { DriveClient, FOLDER_MIME, isSharedDrivePath, withAllDrives } from '../src/drive';
import { buildDriveIndex, planDriveChanges } from '../src/drive-index';
import { syncFileName } from '../src/workspace-files';
import { planPlainDocEdit } from '../src/google-docs';

// These tests cover the desktop/iOS code path; Android transfers are covered in transfer.test.ts.
(Platform as { isAndroidApp: boolean }).isAndroidApp = false;

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | ArrayBuffer) => new TextDecoder().decode(b);

test('Drive change pagination keeps the newest cursor and detects invalid cursors', async () => {
  const pages: string[] = [];
  (globalThis as any).requestUrlMock = async ({ url }: { url: string }) => {
    const token = new URL(url).searchParams.get('pageToken')!;
    pages.push(token);
    if (token === 'expired') return { status: 410, text: '' };
    const changes = [{ fileId: token, removed: true }];
    return { status: 200, json: token === 'first' ? { changes, nextPageToken: 'second' } : { changes, newStartPageToken: 'next' } };
  };
  const drive = new DriveClient(async () => 'fake');
  assert.deepEqual(await drive.changesSince('first'), { cursor: 'next', changes: [
    { fileId: 'first', removed: true }, { fileId: 'second', removed: true },
  ] });
  assert.deepEqual(pages, ['first', 'second']);
  assert.equal(await drive.changesSince('expired'), null);
});

/** In-memory vault with a config folder. */
function fakeVault(initial: Record<string, string>) {
  let clock = 1000;
  const data = new Map<string, { bytes: Uint8Array; mtime: number }>();
  const put = (p: string, bytes: Uint8Array) => data.set(p, { bytes, mtime: ++clock });
  for (const [k, v] of Object.entries(initial)) put(k, enc(v));
  const stat = (p: string) => {
    const f = data.get(p);
    return f ? { type: 'file' as const, mtime: f.mtime, size: f.bytes.length, ctime: 0 } : null;
  };
  const tfile = (p: string) => Object.assign(new TFile(), { path: p, stat: stat(p) });
  const isFolder = (p: string) => [...data.keys()].some((k) => k.startsWith(p + '/'));
  const adapter = {
    stat: async (p: string) => stat(p),
    exists: async (p: string) => data.has(p) || isFolder(p),
    copy: async (a: string, b: string) => { put(b, data.get(a)!.bytes.slice()); },
    readBinary: async (p: string) => data.get(p)!.bytes.slice().buffer,
    read: async (p: string) => dec(data.get(p)!.bytes),
    writeBinary: async (p: string, b: ArrayBuffer) => { put(p, new Uint8Array(b.slice(0))); },
    remove: async (p: string) => { data.delete(p); },
    mkdir: async () => {},
    list: async (dir: string) => {
      const files = new Set<string>(), folders = new Set<string>();
      for (const k of data.keys()) {
        if (!k.startsWith(dir + '/')) continue;
        const rest = k.slice(dir.length + 1).split('/');
        if (rest.length === 1) files.add(k);
        else folders.add(`${dir}/${rest[0]}`);
      }
      return { files: [...files], folders: [...folders] };
    },
  };
  const vault = {
    configDir: '.obsidian',
    adapter,
    getFiles: () => [...data.keys()].filter((k) => !k.startsWith('.obsidian/')).map(tfile),
    getAbstractFileByPath: (p: string) => (data.has(p) ? tfile(p) : isFolder(p) ? {} : null),
    readBinary: async (f: { path: string }) => adapter.readBinary(f.path),
    modifyBinary: async (f: { path: string }, b: ArrayBuffer) => adapter.writeBinary(f.path, b),
    createBinary: async (p: string, b: ArrayBuffer) => adapter.writeBinary(p, b),
    createFolder: async () => {},
  };
  const app = { vault, fileManager: { trashFile: async (f: { path: string }) => { data.delete(f.path); } } };
  const text = (p: string) => (data.has(p) ? dec(data.get(p)!.bytes) : undefined);
  return { app, data, text, put: (p: string, s: string) => put(p, enc(s)) };
}

/** In-memory Drive. Folder ids are their full paths; files live at full paths. */
function fakeDrive(initial: Record<string, string>) {
  let n = 0;
  const files = new Map<string, { id: string; bytes: Uint8Array; v: number }>();
  for (const [k, v] of Object.entries(initial)) files.set(k, { id: `f${++n}`, bytes: enc(v), v: 1 });
  const calls = { uploads: [] as string[], trashed: [] as string[] };
  const meta = (path: string) => {
    const f = files.get(path)!;
    return { id: f.id, name: path.split('/').pop()!, mimeType: 'text/plain', md5Checksum: `${f.id}v${f.v}`, modifiedTime: '', size: String(f.bytes.length) };
  };
  const byId = (id: string) => [...files.entries()].find(([, f]) => f.id === id)!;
  const drive = {
    resetCache: () => {},
    ensureFolderPath: async (p: string) => p,
    ensureChildFolder: async (parent: string, name: string) => `${parent}/${name}`,
    createFolder: async (name: string, parent: string) => `${parent}/${name}`,
    folderAccess: async () => ({ canEdit: true, inSharedDrive: false, canShare: true }),
    listTree: async (root: string) => {
      const out = new Map<string, ReturnType<typeof meta>>();
      const folders = new Map<string, string>([['', root]]);
      for (const path of files.keys()) {
        if (!path.startsWith(root + '/')) continue;
        const rel = path.slice(root.length + 1);
        if (rel.split('/').some((s) => s.startsWith('.'))) continue; // like the real client
        out.set(rel, meta(path));
        const parts = rel.split('/');
        for (let i = 1; i < parts.length; i++) folders.set(parts.slice(0, i).join('/'), `${root}/${parts.slice(0, i).join('/')}`);
      }
      return { files: out, folders, warnings: [] };
    },
    download: async (id: string) => byId(id)[1].bytes.slice().buffer,
    getFile: async (id: string) => meta(byId(id)[0]),
    createFile: async (name: string, parent: string, data: ArrayBuffer) => {
      const path = `${parent}/${name}`;
      files.set(path, { id: `f${++n}`, bytes: new Uint8Array(data.slice(0)), v: 1 });
      calls.uploads.push(path);
      return meta(path);
    },
    updateFile: async (id: string, data: ArrayBuffer) => {
      const [path, f] = byId(id);
      f.bytes = new Uint8Array(data.slice(0));
      f.v++;
      calls.uploads.push(path);
      return meta(path);
    },
    trash: async (id: string) => {
      const [path] = byId(id);
      files.delete(path);
      calls.trashed.push(path);
    },
  };
  const text = (p: string) => (files.has(p) ? dec(files.get(p)!.bytes) : undefined);
  const edit = (p: string, s: string) => { const f = files.get(p)!; f.bytes = enc(s); f.v++; };
  return { drive, files, calls, text, edit };
}

const settings = { remoteFolder: 'Notes', maxFileSizeMB: 0, excludes: '', propagateDeletes: true, transferChunkSizeMiB: 16 } as any;
const hooks = { checkpoint: async () => {}, progress: () => {} };

const plainDoc = {
  revisionId: 'docs-7',
  tabs: [{ tabProperties: { tabId: 'main' }, documentTab: {
    body: { content: [{ paragraph: { elements: [{ startIndex: 1, endIndex: 8, textRun: { content: 'A😀old\n' } }] } }] },
  } }],
};

test('Google Docs edits target only the changed text and require the server revision', async () => {
  const file = { id: 'doc', name: 'Note', mimeType: 'application/vnd.google-apps.document', version: '7', modifiedTime: 'time' };
  let writes = 0;
  (globalThis as any).requestUrlMock = async ({ url, method, body }: { url: string; method: string; body: string }) => {
    if (new URL(url).hostname === 'www.googleapis.com') return { status: 200, json: file };
    if (method === 'GET') return { status: 200, json: plainDoc };
    writes++;
    assert.deepEqual(JSON.parse(body), {
      writeControl: { requiredRevisionId: 'docs-7' },
      requests: [
        { deleteContentRange: { range: { startIndex: 4, endIndex: 7, tabId: 'main' } } },
        { insertText: { location: { index: 4, tabId: 'main' }, text: 'new' } },
      ],
    });
    return { status: 400, text: 'Required revision is no longer current' };
  };
  const drive = new DriveClient(async () => 'fake');
  await assert.rejects(drive.updatePlainGoogleDoc(file, enc('A😀old\n').buffer, enc('A😀new').buffer), /Required revision/);
  assert.equal(writes, 1);
  const rich = structuredClone(plainDoc);
  Object.assign(rich.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun, { textStyle: { bold: true } });
  assert.throws(() => planPlainDocEdit(rich, 'A😀old', 'A😀new'), /cannot be edited safely/);
});

test('a newer Drive version blocks both overwrite and trash', async () => {
  const file = { id: 'f', name: 'Note.md', mimeType: 'text/plain', version: '7', modifiedTime: 'time' };
  (globalThis as any).requestUrlMock = async ({ method }: { method: string }) => {
    assert.equal(method, 'GET', 'must not send a write using stale metadata');
    return { status: 200, json: { ...file, version: '8' } };
  };
  const drive = new DriveClient(async () => 'fake');
  await assert.rejects(drive.updateFile(file.id, enc('edit').buffer, file), /changed during sync/);
  await assert.rejects(drive.trash(file.id, file), /changed during sync/);
});

test('a late competing upload is downloaded without losing this device’s previous upload', async () => {
  const v = fakeVault({ 'race.md': 'local upload' });
  const d = fakeDrive({});
  const state: SyncState = {};
  const sync = () => runSync(v.app as any, d.drive as any, settings, state, hooks);
  assert.equal((await sync()).uploaded, 1);
  d.edit('Notes/race.md', 'other device');
  const result = await sync();
  assert.deepEqual(result.errors, []);
  assert.equal(result.downloaded, 1);
  assert.equal(v.text('race.md'), 'other device');
  const archive = [...v.data.keys()].find(path => path.startsWith('.obsidian/plugins/gsync/previous-versions/'));
  assert.equal(v.text(archive!), 'local upload');
  assert.equal(state['race.md'].uploadedHere, undefined);
});

test('full listing and change feed agree on the projected Workspace paths and exports', async () => {
  const docs = [
    ['document', '.md', 'text/markdown'],
    ['spreadsheet', '.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['presentation', '.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['drawing', '.pdf', 'application/pdf'],
  ].map(([kind, extension, mimeType]) => ({
    file: { id: kind, name: 'тест' + extension, mimeType: 'application/vnd.google-apps.' + kind, modifiedTime: 'date' },
    name: `тест (Google ${kind})${extension}`, mimeType,
  }));
  (globalThis as any).requestUrlMock = async ({ url }: { url: string }) => {
    const request = new URL(url);
    if (request.pathname.endsWith('/export')) {
      const doc = docs.find(doc => request.pathname.includes(`/${doc.file.id}/`))!;
      assert.equal(request.searchParams.get('mimeType'), doc.mimeType);
      return { status: 200, arrayBuffer: enc(doc.name).buffer };
    }
    return { status: 200, json: { files: docs.map(doc => doc.file) } };
  };
  const drive = new DriveClient(async () => 'fake');
  const listed = await drive.listTree('root');
  assert.deepEqual([...listed.files.keys()], docs.map(doc => doc.name));
  const index = buildDriveIndex('key', 'before', { ...listed, files: new Map() });
  const delta = planDriveChanges(index, docs.map(({ file }) => ({ fileId: file.id, file: { ...file, parents: ['root'] } })), [])!;
  assert.deepEqual([...delta.tree.files.keys()], [...listed.files.keys()]);
  for (const doc of docs) assert.equal(dec(await drive.exportWorkspaceFile(doc.file)), doc.name);
});

test('Workspace exports preserve local edits and never change or delete the Google original', async () => {
  const v = fakeVault({});
  const d = fakeDrive({});
  const metadata = { id: 'doc', name: 'тест.md', mimeType: 'application/vnd.google-apps.document', version: '1', modifiedTime: 'date' };
  const path = syncFileName(metadata)!;
  let contents = 'Google version';
  let exports = 0;
  let files = new Map([[path, metadata]]);
  const drive = {
    ...d.drive,
    listTree: async () => ({
      files: new Map([...files].map(([name, file]) => [name, { ...file }])),
      folders: new Map([['', 'Notes']]),
      warnings: [],
    }),
    getFile: async () => ({ ...metadata }),
    exportWorkspaceFile: async () => { exports++; return enc(contents).buffer; },
  };
  const state: SyncState = {};
  const sync = () => runSync(v.app as any, drive as any, settings, state, hooks);
  assert.equal((await sync()).downloaded, 1);
  assert.equal(v.text(path), contents);
  v.put(path, 'local edit');
  assert.deepEqual((await sync()).errors, []);
  assert.equal(exports, 1);
  assert.equal(v.text(path), 'local edit');
  metadata.version = '2';
  contents = 'Google update';
  const result = await sync();
  assert.deepEqual(result.errors, []);
  assert.equal(v.text(path), contents);
  const backup = [...v.data.keys()].find(key => key.includes('(local edit'));
  assert.deepEqual(result.readOnlyKept, [backup]);
  assert.equal(v.text(backup!), 'local edit');
  v.data.delete(backup!);
  metadata.version = '3';
  drive.exportWorkspaceFile = async () => {
    metadata.version = '4';
    return enc('unstable export').buffer;
  };
  assert.match((await sync()).errors[0], /changed during export/);
  assert.equal(state[path].remoteRev, '2');
  assert.equal(v.text(path), contents);
  files = new Map();
  assert.deepEqual((await sync()).errors, []);
  assert.equal(v.text(path), contents);
  assert.deepEqual(d.calls, { uploads: [], trashed: [] });
});

test('enabled plain Docs writeback records verified exports even when newline conventions differ', async () => {
  const v = fakeVault({});
  const d = fakeDrive({});
  const doc = { id: 'plain', name: 'Note', mimeType: 'application/vnd.google-apps.document', version: '1', modifiedTime: 'time' };
  const path = syncFileName(doc)!;
  let cloud = 'old\n';
  const drive = {
    ...d.drive,
    listTree: async () => ({ files: new Map([[path, { ...doc }]]), folders: new Map([['', 'Notes']]), warnings: [] }),
    getFile: async () => ({ ...doc }),
    exportWorkspaceFile: async () => enc(cloud).buffer,
    updatePlainGoogleDoc: async (_doc: unknown, baseline: ArrayBuffer, edited: ArrayBuffer) => {
      assert.equal(dec(baseline), cloud);
      cloud = dec(edited) + '\n';
      doc.version = String(Number(doc.version) + 1);
    },
  };
  const state: SyncState = {};
  const sync = () => runSync(v.app as any, drive as any, { ...settings, writeBackGoogleDocs: true }, state, hooks);
  assert.equal((await sync()).downloaded, 1);
  for (const text of ['first edit', 'second edit']) {
    v.put(path, text);
    const result = await sync();
    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 1);
    assert.equal(cloud, text + '\n');
  }
  assert.equal(state[path].remoteRev, '3');
});

test('Workspace deletions respect the setting, source revision and local edits', async () => {
  for (const scenario of ['local-delete', 'drive-delete', 'local-edit', 'local-off', 'drive-off', 'competing-edit', 'read-only', 'no-access', 'moved']) {
    const v = fakeVault({});
    const d = fakeDrive({});
    const doc = { id: 'native', name: 'Test', mimeType: 'application/vnd.google-apps.document', version: '1', modifiedTime: 'date', trashed: false };
    const path = syncFileName(doc)!;
    let cloudTrashes = 0;
    let listed = true;
    const drive = {
      ...d.drive,
      listTree: async () => ({
        files: new Map(listed && !doc.trashed ? [[path, { ...doc }]] : []),
        folders: new Map([['', 'Notes']]), warnings: [],
      }),
      getFile: async () => {
        if (!listed && scenario === 'no-access') throw new Error('Drive API 404: File not found');
        return { ...doc };
      },
      exportWorkspaceFile: async () => enc(doc.version === '1' ? 'exported' : 'new edit').buffer,
      trash: async (id: string, expected: typeof doc) => {
        assert.equal(id, doc.id);
        assert.equal(expected.version, doc.version);
        cloudTrashes++;
        doc.trashed = true;
      },
    };
    const state: SyncState = {};
    const scope = { localPrefix: '', remotePath: 'Notes', otherPrefixes: [], readOnly: scenario === 'read-only' };
    const sync = () => runSync(v.app as any, drive as any, { ...settings, propagateDeletes: !scenario.endsWith('-off') }, state, hooks, scope);
    assert.equal((await sync()).downloaded, 1, scenario);

    if (['local-delete', 'local-off', 'competing-edit', 'read-only'].includes(scenario)) v.data.delete(path);
    if (['drive-delete', 'drive-off', 'local-edit'].includes(scenario)) doc.trashed = true;
    if (scenario === 'competing-edit') doc.version = '2';
    if (scenario === 'local-edit') v.put(path, 'my edits'); // Same size as the original export.
    if (scenario === 'no-access' || scenario === 'moved') listed = false;

    const r = await sync();
    assert.deepEqual(r.errors, [], scenario);
    assert.equal(cloudTrashes, scenario === 'local-delete' ? 1 : 0, scenario);
    assert.equal(r.deletedRemote, cloudTrashes, scenario);
    assert.equal(r.deletedLocal, scenario === 'drive-delete' ? 1 : 0, scenario);
    const expected = scenario === 'local-edit' ? 'my edits' : scenario === 'competing-edit' ? 'new edit'
      : ['local-delete', 'drive-delete'].includes(scenario) ? undefined : 'exported';
    assert.equal(v.text(path), expected, scenario);
    assert.equal(!!state[path], expected !== undefined, scenario);
  }
});

test('regular Office and PDF files are still transferred in both directions', async () => {
  const v = fakeVault({ 'office.docx': 'binary office data' });
  const d = fakeDrive({ 'Notes/document.pdf': 'binary pdf data' });
  const state: SyncState = {};
  const result = await runSync(v.app as any, d.drive as any, settings, state, hooks);
  assert.deepEqual(result.errors, []);
  assert.equal(result.uploaded, 1);
  assert.equal(result.downloaded, 1);
  assert.equal(d.text('Notes/office.docx'), 'binary office data');
  assert.equal(v.text('document.pdf'), 'binary pdf data');
});

test('the incremental queue uploads a local edit and downloads a Drive edit without enumerating the vault', async () => {
  const v = fakeVault({ 'local.md': 'local', 'remote.md': 'remote', 'untouched.md': 'old' });
  const d = fakeDrive({ 'Notes/local.md': 'local', 'Notes/remote.md': 'remote', 'Notes/untouched.md': 'old' });
  const state: SyncState = {};
  const tree = await d.drive.listTree('Notes');
  assert.deepEqual((await runSync(v.app as any, d.drive as any, settings, state, hooks, undefined, { tree })).errors, []);
  const index = buildDriveIndex('scope', 'before', tree);
  v.put('local.md', 'local edit');
  d.edit('Notes/remote.md', 'Drive edit');
  const remote = await d.drive.getFile(state['remote.md'].remoteId);
  const plan = planDriveChanges(index, [{ fileId: remote.id, file: { ...remote, parents: ['Notes'] } }], ['local.md'])!;
  v.app.vault.getFiles = () => assert.fail('incremental sync enumerated the vault');
  d.drive.listTree = async () => assert.fail('incremental sync enumerated Drive');
  const result = await runSync(v.app as any, d.drive as any, settings, state, hooks, undefined, { tree: plan.tree, paths: plan.affected });
  assert.deepEqual(result.errors, []);
  assert.equal(result.downloaded, 1);
  assert.deepEqual(d.calls.uploads, ['Notes/local.md']);
  assert.equal(d.text('Notes/local.md'), 'local edit');
  assert.equal(v.text('remote.md'), 'Drive edit');
  assert.equal(index.cursor, 'before');
  plan.commit('after', plan.tree);
  assert.equal(index.cursor, 'after');
  assert.equal(index.files['local.md'].md5Checksum, state['local.md'].remoteRev);
  assert.equal(planDriveChanges(index, [], [])!.affected.size, 0);
});

test('file moves queue the old and new paths while folder changes require a full listing', async () => {
  const drive = fakeDrive({ 'Notes/folder/file.md': 'text' }).drive;
  const index = buildDriveIndex('scope', 'before', await drive.listTree('Notes'));
  const original = index.files['folder/file.md'];
  const moved = { ...original, name: 'moved.md', parents: ['Notes'] };
  const plan = planDriveChanges(index, [{ fileId: original.id, file: moved }], [])!;
  assert.deepEqual([...plan.affected].sort(), ['folder/file.md', 'moved.md']);
  assert.deepEqual([...plan.tree.files.keys()], ['moved.md']);
  assert.equal(planDriveChanges(index, [{ fileId: 'Notes/folder', removed: true }], []), null);
  assert.equal(planDriveChanges(index, [{
    fileId: 'new-folder', file: { ...moved, id: 'new-folder', mimeType: FOLDER_MIME },
  }], []), null);
});

test('direct disk edits upload with stale Obsidian metadata and new unindexed files upload in delta and full sync', async () => {
  for (const full of [false, true]) {
    const v = fakeVault({ 'note.md': 'old' });
    const d = fakeDrive({ 'Notes/note.md': 'old' });
    const state: SyncState = {};
    const tree = await d.drive.listTree('Notes');
    assert.deepEqual((await runSync(v.app as any, d.drive as any, settings, state, hooks, undefined, { tree })).errors, []);
    const stale = v.app.vault.getFiles();
    v.app.vault.getFiles = () => stale;
    v.app.vault.getAbstractFileByPath = path => stale.find(file => file.path === path) ?? null;
    v.app.vault.readBinary = async () => assert.fail('external changes must be read from disk');
    v.put('note.md', 'new'); // Same length, fresh mtime.
    v.put('Nested/created.md', 'created outside Obsidian');
    const diskPaths = new Set(['note.md', 'Nested/created.md']);
    const result = await runSync(v.app as any, d.drive as any, settings, state, hooks, undefined, {
      tree, paths: full ? undefined : diskPaths, diskPaths,
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.uploaded, 2);
    assert.equal(d.text('Notes/note.md'), 'new');
    assert.equal(d.text('Notes/Nested/created.md'), 'created outside Obsidian');
  }
});

// ---- folder pairs ----------------------------------------------------------

test('whole-vault folder leaves other pairs\' vault folders alone, in both directions', async () => {
  const v = fakeVault({ 'a.md': 'A', 'Work/w.md': 'W' });
  const d = fakeDrive({ 'Notes/b.md': 'B', 'Notes/Work/stray.md': 'S' });
  const state: SyncState = {};
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, { localPrefix: '', remotePath: 'Notes', otherPrefixes: ['Work'], readOnly: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads, ['Notes/a.md']);
  assert.equal(v.text('b.md'), 'B');
  assert.equal(v.text('Work/stray.md'), undefined, 'main pair must not write into another pair\'s folder');
  assert.deepEqual(Object.keys(state).sort(), ['a.md', 'b.md']);
});

test('an extra pair maps a vault folder to its own Drive folder', async () => {
  const v = fakeVault({ 'a.md': 'A', 'Work/w.md': 'W', 'Work/sub/x.md': 'X' });
  const d = fakeDrive({ 'Company/Shared/team.md': 'T' });
  const state: SyncState = {};
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, { localPrefix: 'Work', remotePath: 'Company/Shared', otherPrefixes: [], readOnly: false });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads.sort(), ['Company/Shared/sub/x.md', 'Company/Shared/w.md']);
  assert.equal(v.text('Work/team.md'), 'T');
  assert.ok(!d.files.has('Company/Shared/a.md'), 'files outside the pair are not uploaded');
  assert.deepEqual(Object.keys(state).sort(), ['Work/sub/x.md', 'Work/team.md', 'Work/w.md']);
});

// ---- view-only folders -----------------------------------------------------

test('view-only folder: Drive wins, local edits are kept as copies, nothing is uploaded or trashed', async () => {
  const v = fakeVault({});
  const d = fakeDrive({ 'Company/Shared/team.md': 'v1', 'Company/Shared/gone.md': 'G' });
  const scope = { localPrefix: 'Work', remotePath: 'Company/Shared', otherPrefixes: [], readOnly: true };
  const state: SyncState = {};
  await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.equal(v.text('Work/team.md'), 'v1');

  v.put('Work/team.md', 'my edit');          // edit a view-only file
  v.put('Work/new.md', 'mine');               // add a file
  v.data.delete('Work/gone.md');              // delete a file
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(d.calls.uploads, []);
  assert.deepEqual(d.calls.trashed, []);
  assert.equal(v.text('Work/team.md'), 'v1', 'Drive version restored');
  const copy = [...v.data.keys()].find((k) => k.includes('(local edit'));
  assert.ok(copy && v.text(copy) === 'my edit', 'local edit kept as a copy');
  assert.equal(v.text('Work/gone.md'), 'G', 'deleted file restored from Drive');
  assert.equal(v.text('Work/new.md'), 'mine', 'new local file left alone');
  assert.ok(r.readOnlyKept.includes('Work/new.md') && r.readOnlyKept.includes(copy!));
});

test('view-only folder still downloads Drive changes', async () => {
  const v = fakeVault({});
  const d = fakeDrive({ 'S/t.md': 'v1' });
  const scope = { localPrefix: 'Work', remotePath: 'S', otherPrefixes: [], readOnly: true };
  const state: SyncState = {};
  await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  d.edit('S/t.md', 'v2');
  const r = await runSync(v.app as any, d.drive as any, settings, state, hooks, scope);
  assert.equal(r.downloaded, 1);
  assert.equal(v.text('Work/t.md'), 'v2');
  assert.deepEqual(r.readOnlyKept, []);
});

// ---- settings sync ---------------------------------------------------------

test('config categories: never GSync, window layout, hidden or unknown files', () => {
  const cfg = { ...DEFAULT_CONFIG_SYNC, enabled: true, excludedPlugins: 'obsidian-git\n# comment\nplugins/excalidraw/' };
  assert.equal(configCategory('app.json', cfg), 'core');
  assert.equal(configCategory('hotkeys.json', cfg), 'core');
  assert.equal(configCategory('appearance.json', cfg), 'appearance');
  assert.equal(configCategory('themes/Minimal/theme.css', cfg), 'appearance');
  assert.equal(configCategory('snippets/my.css', cfg), 'appearance');
  assert.equal(configCategory('community-plugins.json', cfg), 'pluginList');
  assert.equal(configCategory('plugins/dataview/main.js', cfg), 'plugins');
  for (const never of ['plugins/gsync/data.json', 'plugins/gsync/transfers/x/data', 'plugins/gdrive-vault-sync/data.json',
    'workspace.json', 'workspace-mobile.json', 'plugins/obsidian-git/data.json', 'plugins/excalidraw/main.js',
    'plugins/x/.git/HEAD', 'plugins/x/node_modules/a.js', 'notes.txt', 'plugins/manifest.json']) {
    assert.equal(configCategory(never, cfg), null, never);
  }
  assert.equal(configCategory('app.json', { ...cfg, core: false }), null);
  assert.equal(configCategory('plugins/dataview/main.js', { ...cfg, plugins: false }), null);
});

test('plugin list merge keeps locally-kept plugins per device', () => {
  const keep = localPlugins({ ...DEFAULT_CONFIG_SYNC, excludedPlugins: 'obsidian-git' });
  assert.deepEqual(mergePluginLists(['dataview', 'obsidian-git'], ['gsync', 'calendar'], keep).sort(), ['dataview', 'gsync']);
  assert.deepEqual(mergePluginLists(['dataview'], ['obsidian-git'], keep).sort(), ['dataview', 'obsidian-git']);
});

test('settings sync: a new device adopts Drive\'s setup without leaking GSync\'s own data', async () => {
  const v = fakeVault({
    '.obsidian/app.json': '{"a":1}',
    '.obsidian/community-plugins.json': '["gsync","calendar"]',
    '.obsidian/plugins/gsync/data.json': '{"refreshToken":"SECRET"}',
    '.obsidian/plugins/calendar/main.js': 'cal',
    '.obsidian/workspace-mobile.json': 'phone layout',
  });
  const d = fakeDrive({
    'Notes/.obsidian/app.json': '{"a":2}',
    'Notes/.obsidian/community-plugins.json': '["dataview","obsidian-git"]',
    'Notes/.obsidian/plugins/dataview/main.js': 'dv',
    'Notes/.obsidian/workspace.json': 'pc layout',
  });
  const cfg = { ...DEFAULT_CONFIG_SYNC, enabled: true, excludedPlugins: 'obsidian-git' };
  const state: SyncState = {};
  const r = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.deepEqual(r.errors, []);
  assert.ok(r.needsRestart);
  assert.equal(v.text('.obsidian/app.json'), '{"a":2}', 'first run adopts Drive\'s settings');
  assert.deepEqual(JSON.parse(v.text('.obsidian/community-plugins.json')!).sort(), ['dataview', 'gsync'], 'GSync stays on; excluded plugin keeps local state');
  assert.equal(v.text('.obsidian/plugins/dataview/main.js'), 'dv');
  assert.equal(v.text('.obsidian/workspace-mobile.json'), 'phone layout');
  assert.equal(d.text('Notes/.obsidian/workspace.json'), 'pc layout');
  assert.ok(![...d.files.keys()].some((k) => k.includes('plugins/gsync')), 'GSync data never uploaded');
  assert.deepEqual(JSON.parse(d.text('Notes/.obsidian/community-plugins.json')!).sort(), ['dataview', 'obsidian-git'], 'Drive list untouched');
  assert.equal(d.text('Notes/.obsidian/plugins/calendar/main.js'), 'cal', 'device-only plugin files are shared (but stay off)');

  // Turn on a plugin on this device: Drive's list gets it, but never "gsync".
  v.put('.obsidian/community-plugins.json', '["dataview","gsync","templater"]');
  const r2 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.deepEqual(r2.errors, []);
  assert.deepEqual(JSON.parse(d.text('Notes/.obsidian/community-plugins.json')!).sort(), ['dataview', 'obsidian-git', 'templater']);

  // Another device changes a setting: it arrives here.
  d.edit('Notes/.obsidian/app.json', '{"a":3}');
  const r3 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.equal(r3.downloaded, 1);
  assert.equal(v.text('.obsidian/app.json'), '{"a":3}');

  // Nothing changed: nothing moves.
  const before = d.calls.uploads.length;
  const r4 = await runConfigSync(v.app as any, d.drive as any, cfg, 'Notes', state, { propagateDeletes: true, maxBytes: 0 });
  assert.equal(r4.uploaded + r4.downloaded + r4.deleted, 0);
  assert.equal(d.calls.uploads.length, before);
  assert.equal(r4.needsRestart, false);
});

// ---- Shared Drives ---------------------------------------------------------

test('Shared Drive support is added to Drive file calls only', () => {
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/files/abc?alt=media'), 'https://www.googleapis.com/drive/v3/files/abc?alt=media&supportsAllDrives=true');
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/files'), 'https://www.googleapis.com/drive/v3/files?supportsAllDrives=true');
  assert.equal(withAllDrives('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'), 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true');
  const session = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=XYZ';
  assert.equal(withAllDrives(session), session, 'resumable session URLs are used as given');
  assert.equal(withAllDrives('https://www.googleapis.com/drive/v3/drives?q=x'), 'https://www.googleapis.com/drive/v3/drives?q=x');
  const already = 'https://www.googleapis.com/drive/v3/files/a/permissions?supportsAllDrives=true';
  assert.equal(withAllDrives(already), already);
  assert.ok(isSharedDrivePath('Shared drives/Company/Notes'));
  assert.ok(isSharedDrivePath('shared drives\\Company'));
  assert.ok(!isSharedDrivePath('Obsidian/Shared drives'));
});

test('Shared Drive folders work only when the Teams add-on supplies a resolver', async () => {
  const { DriveClient } = await import('../src/drive');
  const drive = new DriveClient(async () => 'token');
  await assert.rejects(drive.ensureFolderPath('Shared drives/Acme'), /GSync Teams add-on/);
  const asked: string[] = [];
  drive.sharedDriveResolver = async (name) => { asked.push(name); return 'drive-123'; };
  assert.equal(await drive.ensureFolderPath('Shared drives/Acme'), 'drive-123');
  assert.deepEqual(asked, ['Acme']);
  assert.equal(await drive.ensureFolderPath('Shared drives/Acme'), 'drive-123');
  assert.deepEqual(asked, ['Acme'], 'resolved once per sync');
});
