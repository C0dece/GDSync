import { SyncProgress } from "./progress";
import { Notice, ObsidianProtocolData, Platform, Plugin, TAbstractFile, TFile } from "obsidian";
import { exchangeCode, isPendingValid, PendingAuth, prepareSignIn, PreparedSignIn, PROTOCOL_ACTION, refreshAccessToken } from "./auth";
import { DriveClient, FolderAccess, isSharedDrivePath } from "./drive";
import { normalizeTransferChunkSizeMiB } from "./transfer-settings";
import { cleanPath, DEFAULT_SETTINGS, GSyncSettings, GSyncSettingTab } from "./settings";
import { runSync, SyncResult, SyncScope, SyncState, underPrefix } from "./sync";
import { DEFAULT_CONFIG_SYNC, runConfigSync } from "./config-sync";
import { GSYNC_API_VERSION, GSyncApi, GSyncFolder, TeamsExtension } from "./api";
import { buildDriveIndex, DriveIndex, planDriveChanges } from "./drive-index";
import { watchVaultDisk } from "./disk-watch";

interface PluginData {
  settings?: Partial<GSyncSettings>;
  /** Sync history for the whole-vault folder. */
  state?: SyncState;
  /** Sync history for each extra folder pair, by pair id. */
  pairStates?: Record<string, SyncState>;
  /** Sync history for settings sync. */
  configState?: SyncState;
  syncInProgress?: boolean;
  pendingAuth?: PendingAuth | null;
  driveIndexes?: Record<string, DriveIndex>;
  pendingLocalPaths?: string[];
  pendingFullSync?: boolean;
}

export default class GSyncPlugin extends Plugin {
  settings: GSyncSettings = { ...DEFAULT_SETTINGS };
  state: SyncState = {};
  pairStates: Record<string, SyncState> = {};
  configState: SyncState = {};
  /** This device's access to each folder pair ("main" = whole vault), from the last sync. */
  access = new Map<string, FolderAccess>();
  /** The GSync Teams add-on, when it's installed, enabled and licensed. */
  teams: TeamsExtension | null = null;
  private accessToken = "";
  private expiresAt = 0;
  private syncing = false;
  private syncInProgress = false;
  private interruptedLastTime = false;
  private pendingAuth: PendingAuth | null = null;
  private prepared: PreparedSignIn | null = null;
  private autoSyncId: number | null = null;
  private queuedSyncId: number | undefined;
  private pendingPaths = new Set<string>();
  private lastLocalActivity = 0;
  private editedPaths = new Map<string, number>();
  private inFlightPaths: ReadonlySet<string> = new Set();
  private inFlightFull = false;
  private saveTail: Promise<void> = Promise.resolve();
  private queueSaveScheduled = false;
  private queueNeedsSave = false;
  private rescanLocal = true;
  private forceFull = false;
  private layoutReady = false;
  private driveIndexes: Record<string, DriveIndex> = {};
  private statusEl!: HTMLElement;
  private activeProgress: SyncProgress | null = null;
  private progressNotice: Notice | null = null;
  private progressLastPaint = 0;
  private settingTab!: GSyncSettingTab;
  private drive = new DriveClient(() => this.getAccessToken());

  get driveClient(): DriveClient {
    return this.drive;
  }

  isTeams(): boolean {
    return this.teams !== null;
  }

  /** Interface for add-ons such as GSync Teams (see src/api.ts). */
  readonly api: GSyncApi = {
    version: GSYNC_API_VERSION,
    request: (url, opts) => this.drive.request(url, opts),
    ensureFolderPath: (path) => this.drive.ensureFolderPath(path),
    folderAccess: (folderId) => this.drive.folderAccess(folderId),
    folders: (): GSyncFolder[] => [
      { id: "main", local: "", remote: this.settings.remoteFolder },
      ...this.settings.pairs.filter((p) => p.local && p.remote).map((p) => ({ id: p.id, local: p.local, remote: p.remote })),
    ],
    registerTeams: (ext) => {
      this.teams = ext;
      this.drive.sharedDriveResolver = (name) => ext.resolveSharedDrive(name);
      return () => {
        if (this.teams !== ext) return;
        this.teams = null;
        this.drive.sharedDriveResolver = null;
      };
    },
  };

  async onload() {
    const data = ((await this.loadData()) ?? {}) as PluginData;
    this.settings = { ...DEFAULT_SETTINGS, ...(data.settings ?? {}) };
    this.settings.configSync = { ...DEFAULT_CONFIG_SYNC, ...(data.settings?.configSync ?? {}) };
    this.settings.pairs = (this.settings.pairs ?? []).map((p) => ({ ...p }));
    this.pairStates = data.pairStates ?? {};
    this.configState = data.configState ?? {};
    this.settings.transferChunkSizeMiB = normalizeTransferChunkSizeMiB(this.settings.transferChunkSizeMiB);
    this.state = data.state ?? {};
    this.interruptedLastTime = !!data.syncInProgress;
    this.driveIndexes = this.interruptedLastTime ? {} : data.driveIndexes ?? {};
    this.pendingPaths = new Set(data.pendingLocalPaths ?? []);
    this.forceFull = data.pendingFullSync === true;
    this.pendingAuth = data.pendingAuth ?? null;
    this.settings.remoteFolder = this.settings.remoteFolder.replace(/\\/g, "/");
    if (!this.settings.remoteFolder) this.settings.remoteFolder = `Obsidian/${this.app.vault.getName()}`;

    this.settingTab = new GSyncSettingTab(this.app, this);
    this.addSettingTab(this.settingTab);
    const statusItem = this.addStatusBarItem();
    this.statusEl = Platform.isMobile ? statusItem : statusItem.createEl("button", { attr: { type: "button", "aria-label": "Sync with Google Drive" } });
    if (!Platform.isMobile) this.registerDomEvent(this.statusEl, "click", () => void this.sync(false));
    this.setStatus("GDSync: idle");

    this.addRibbonIcon("refresh-cw", "Sync with Google Drive", () => void this.sync(false));
    this.addCommand({ id: "sync-now", name: "Sync now", callback: () => void this.sync(false) });

    this.addCommand({ id: "show-sync-progress", name: "Show sync progress", callback: () => this.showSyncProgress() });
    this.register(() => this.progressNotice?.hide());
    this.addCommand({ id: "full-sync", name: "Run full sync", callback: () => void this.sync(false, true) });
    this.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile) this.queueLocal(file); }));
    this.registerEvent(this.app.vault.on("modify", file => this.queueLocal(file)));
    this.registerEvent(this.app.vault.on("delete", file => this.queueLocal(file)));
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.queueLocal(file, oldPath)));
    this.registerEvent(this.app.workspace.on("editor-change", (_editor, info) => {
      if (info.file) this.queueLocal(info.file);
    }));
    this.registerDomEvent(window, "focus", () => {
      if (!document.hidden) this.queueSync();
    });
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.hidden) this.flushMobileQueue();
      else this.queueSync();
    });
    this.registerDomEvent(window, "online", () => {
      if (this.pendingPaths.size || this.forceFull) this.queueSync();
    });
    this.register(() => window.clearTimeout(this.queuedSyncId));

    // Google -> callback.html -> obsidian://gsync-auth?code=...&state=...
    this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
      void this.finishSignIn(params);
    });

    this.app.workspace.onLayoutReady(() => {
      this.layoutReady = true;
      this.watchDesktopVault();
      const resumeMobile = Platform.isMobile && this.settings.syncOnChanges &&
        (this.pendingPaths.size > 0 || this.forceFull || (this.interruptedLastTime && this.settings.syncOnStartup));
      if (resumeMobile) {
        this.queueSync();
        return;
      }
      if (this.interruptedLastTime) {
        new Notice("GDSync: the last sync didn't finish (Obsidian closed or crashed). Auto-sync on startup was skipped. Progress was saved, so tap Sync now to resume.", 15000);
        return;
      }
      if (this.settings.syncOnStartup && this.settings.refreshToken) {
        window.setTimeout(() => void this.sync(true), 5000);
      }
    });
    this.scheduleAutoSync(false);
  }

  saveAll(): Promise<void> {
    const save = this.saveTail.then(() => this.saveData({
      settings: this.settings,
      state: this.state,
      pairStates: this.pairStates,
      configState: this.configState,
      syncInProgress: this.syncInProgress,
      pendingAuth: this.pendingAuth,
      driveIndexes: this.driveIndexes,
      pendingLocalPaths: [...new Set([...this.inFlightPaths, ...this.pendingPaths])],
      pendingFullSync: this.forceFull || this.inFlightFull,
    } satisfies PluginData));
    this.saveTail = save.catch(() => undefined);
    return save;
  }

  /** Called when the settings tab opens, so the tap can open the browser instantly. */
  async prepareSignInLink(): Promise<void> {
    const { clientId, redirectUri } = this.settings;
    if (!clientId) return;
    const fresh =
      this.prepared &&
      this.prepared.url.includes(encodeURIComponent(clientId)) &&
      this.prepared.pending.redirectUri === redirectUri &&
      isPendingValid(this.prepared.pending);
    if (fresh) return;
    try {
      this.prepared = await prepareSignIn(clientId, redirectUri, this.app.vault.getName());
    } catch (e) {
      console.error("[gdsync] could not prepare sign-in", e);
      this.prepared = null;
    }
  }

  /** Must run synchronously inside the button tap (no await before window.open). */
  startSignIn(): void {
    const p = this.prepared;
    if (!p || !p.url.includes(encodeURIComponent(this.settings.clientId)) || p.pending.redirectUri !== this.settings.redirectUri) {
      new Notice("Preparing sign-in… tap Sign in with Google again in a moment.");
      void this.prepareSignInLink();
      return;
    }
    const win = window.open(p.url);
    this.pendingAuth = p.pending;
    this.prepared = null; // each attempt gets fresh codes
    if (win === null) {
      // Browser was blocked: hand the link over another way.
      void navigator.clipboard.writeText(p.url).catch(() => undefined);
      new Notice("Couldn't open your browser. The sign-in link was copied: paste it into Safari or Chrome.", 15000);
    } else {
      new Notice("Finish signing in in your browser. It will send you back to Obsidian.", 10000);
    }
    void this.saveAll(); // survives the app being closed while the browser is open
    void this.prepareSignInLink(); // ready for a retry
  }

  private async finishSignIn(params: ObsidianProtocolData) {
    const pending = this.pendingAuth;
    try {
      if (params.error) throw new Error(`Google returned: ${params.error}`);
      if (!params.code) throw new Error("No sign-in code was received.");
      if (!isPendingValid(pending)) throw new Error("This sign-in link expired or wasn't started on this device. Tap Sign in with Google again.");
      if (params.state !== pending.state) throw new Error("Sign-in state didn't match. Tap Sign in with Google again.");
      const tokens = await exchangeCode(this.settings.clientId, this.settings.clientSecret, params.code, pending);
      this.settings.refreshToken = tokens.refreshToken;
      this.driveIndexes = {};
      this.setAccessToken(tokens.accessToken, tokens.expiresAt);
      new Notice("GDSync: signed in to Google Drive.");
    } catch (e) {
      new Notice(`GDSync sign-in failed: ${(e as Error).message}`, 15000);
    } finally {
      this.pendingAuth = null;
      await this.saveAll();
      this.settingTab.refresh();
    }
  }

  setAccessToken(token: string, expiresAt: number) {
    if (!token) this.driveIndexes = {};
    this.accessToken = token;
    this.expiresAt = expiresAt;
  }

  private async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.expiresAt) return this.accessToken;
    const { clientId, clientSecret, refreshToken } = this.settings;
    if (!refreshToken) throw new Error("Not signed in to Google Drive.");
    const t = await refreshAccessToken(clientId, clientSecret, refreshToken);
    this.setAccessToken(t.accessToken, t.expiresAt);
    return t.accessToken;
  }

  scheduleAutoSync(runOnEnable = true) {
    if (this.autoSyncId !== null) window.clearInterval(this.autoSyncId);
    this.autoSyncId = null;
    if (this.settings.syncOnChanges) {
      if (runOnEnable) this.queueSync();
      return;
    }
    window.clearTimeout(this.queuedSyncId);
    const mins = this.settings.autoSyncMinutes;
    if (mins > 0) {
      this.autoSyncId = window.setInterval(() => void this.sync(true), mins * 60 * 1000);
      this.registerInterval(this.autoSyncId);
    }
  }

  private queueLocal(file: TAbstractFile, oldPath?: string) {
    const visible = (path: string) => !underPrefix(path, this.app.vault.configDir) && !path.split("/").some(part => part.startsWith("."));
    const paths = [file.path, oldPath].filter((path): path is string => path !== undefined && visible(path));
    if (!paths.length) return;
    this.lastLocalActivity = Date.now();
    for (const path of paths) this.editedPaths.set(path, this.lastLocalActivity);
    if (file instanceof TFile) {
      for (const path of paths) this.pendingPaths.add(path);
    } else this.forceFull = true;
    if (Platform.isMobile && this.layoutReady && this.settings.syncOnChanges) this.persistMobileQueue();
    if (!this.syncing) this.queueSync();
  }

  private watchDesktopVault() {
    if (!Platform.isDesktopApp) return;
    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    if (!adapter.getBasePath) return;
    let reported = false;
    const onError = (error: unknown) => {
      if (reported) return;
      reported = true;
      console.warn('[gdsync] vault disk watcher', error);
      new Notice('Could not watch some disk changes. Obsidian file events still work.');
    };
    try {
      const close = watchVaultDisk(adapter.getBasePath(),
        path => !underPrefix(path, this.app.vault.configDir) && !path.split('/').some(part => part.startsWith('.')),
        path => {
          this.lastLocalActivity = Date.now();
          this.editedPaths.set(path, this.lastLocalActivity);
          this.pendingPaths.add(path);
          if (!this.syncing) this.queueSync();
        }, onError);
      this.register(close);
    } catch (error) {
      onError(error);
    }
  }

  private persistMobileQueue() {
    this.queueNeedsSave = true;
    if (this.queueSaveScheduled) return;
    this.queueSaveScheduled = true;
    void (async () => {
      try {
        while (this.queueNeedsSave) {
          this.queueNeedsSave = false;
          await this.saveAll();
        }
      } catch (e) {
        console.error('[gdsync] failed to save upload queue', e);
      } finally {
        this.queueSaveScheduled = false;
      }
    })();
  }

  private flushMobileQueue() {
    if (!Platform.isMobile || !this.layoutReady || !this.settings.syncOnChanges || !this.settings.refreshToken ||
      (!this.pendingPaths.size && !this.forceFull)) return;
    window.clearTimeout(this.queuedSyncId);
    if (this.syncing) this.persistMobileQueue();
    else void this.sync(true);
  }

  private queueSync(afterActivity = false) {
    if (!this.layoutReady || (!this.settings.syncOnChanges && !afterActivity) || !this.settings.refreshToken) return;
    window.clearTimeout(this.queuedSyncId);
    const idle = Math.max(0, 5000 - (Date.now() - this.lastLocalActivity));
    this.queuedSyncId = window.setTimeout(() => void this.sync(true), Math.max(1500, idle));
  }

  private setStatus(text: string) {
    this.statusEl.setText(text);
  }

  private showSyncProgress() {
    if (!this.activeProgress) { new Notice("No sync in progress."); return; }
    this.progressNotice?.hide();
    this.progressNotice = new Notice(this.activeProgress.text(), 0);
  }

  updateProgressNotifications() {
    if (this.settings.showSyncNotifications) return;
    this.progressNotice?.hide();
    this.progressNotice = null;
  }

  private renderProgress(force = false, showNotice = false) {
    if (!this.activeProgress) return;
    const now = performance.now();
    if (!force && now - this.progressLastPaint < 250) return;
    this.progressLastPaint = now;
    const text = this.activeProgress.text();
    this.setStatus(text.replace(/\n/g, " · "));
    if (this.progressNotice) this.progressNotice.setMessage(text);
    else if (showNotice && this.settings.showSyncNotifications && Platform.isMobile) this.showSyncProgress();
  }

  /** Problems with the folder pairs, by pair id. A bad pair is skipped; the rest still sync. */
  validatePairs(): Map<string, string> {
    const problems = new Map<string, string>();
    const pairs = this.settings.pairs;
    for (const p of pairs) {
      const local = cleanPath(p.local);
      if (!local || !p.remote) problems.set(p.id, "Set both a vault folder and a Drive folder.");
      else if (local.split("/").some((seg) => seg.startsWith("."))) problems.set(p.id, "Hidden folders can't be synced.");
      else if (pairs.some((o) => o !== p && o.local && (underPrefix(local, cleanPath(o.local)) || underPrefix(cleanPath(o.local), local))))
        problems.set(p.id, `"${local}" overlaps another folder pair.`);
      else if (isSharedDrivePath(p.remote) && !this.isTeams()) problems.set(p.id, "Folders in Shared Drives need the GSync Teams add-on.");
    }
    return problems;
  }

  private async syncAllFolders(quiet: boolean, pending: Set<string>, full: boolean): Promise<SyncResult & { needsRestart: boolean }> {
    const s = this.settings;
    this.drive.resetCache();
    const total: SyncResult & { needsRestart: boolean } = {
      uploaded: 0, downloaded: 0, deletedLocal: 0, deletedRemote: 0,
      conflicts: [], errors: [], warnings: [], skipped: [], readOnlyKept: [], needsRestart: false,
    };
    const add = (r: SyncResult) => {
      total.uploaded += r.uploaded;
      total.downloaded += r.downloaded;
      total.deletedLocal += r.deletedLocal;
      total.deletedRemote += r.deletedRemote;
      for (const k of ["conflicts", "errors", "warnings", "skipped", "readOnlyKept"] as const) total[k].push(...r[k]);
    };
    const hooks = {
      checkpoint: () => this.saveAll(),
      shouldDefer: (path: string) => quiet && !(Platform.isMobile && document.hidden) &&
        Date.now() - (this.editedPaths.get(path) ?? 0) < 5000,
      defer: (path: string) => { this.pendingPaths.add(path); },
      progress: (done: number, count: number, transferred: number) => {
        this.activeProgress?.files(done, count);
        this.renderProgress(done === count, transferred > 0 || !quiet);
      },
      transfer: (progress: Parameters<NonNullable<Parameters<typeof runSync>[4]["transfer"]>>[0]) => {
        const changed = this.activeProgress?.transfer(progress);
        this.renderProgress(changed, true);
      },
    };

    const problems = this.validatePairs();
    const pairs = s.pairs.filter((p) => !problems.has(p.id));
    for (const [id, msg] of problems) {
      const p = s.pairs.find((x) => x.id === id);
      if (p && (p.local || p.remote)) total.errors.push(`Folder pair "${p.local || p.remote}": ${msg}`);
    }

    const jobs: { id: string; scope: Omit<SyncScope, "readOnly">; state: () => SyncState }[] = [
      {
        id: "main",
        scope: { localPrefix: "", remotePath: s.remoteFolder, otherPrefixes: pairs.map((p) => cleanPath(p.local)) },
        state: () => this.state,
      },
      ...pairs.map((p) => ({
        id: p.id,
        scope: { localPrefix: cleanPath(p.local), remotePath: p.remote, otherPrefixes: [] },
        state: () => (this.pairStates[p.id] ??= {}),
      })),
    ];
    if (isSharedDrivePath(s.remoteFolder) && !this.isTeams()) {
      jobs.shift();
      total.errors.push("The whole-vault Drive folder is in a Shared Drive, which needs the GSync Teams add-on.");
    }

    for (const job of jobs) {
      let applying = false;
      try {
        hooks.transfer({ phase: 'folder', path: job.scope.remotePath });
        const rootId = await this.drive.ensureFolderPath(job.scope.remotePath);
        hooks.transfer({ phase: 'access', path: job.scope.remotePath });
        const access = await this.drive.folderAccess(rootId);
        this.access.set(job.id, access);
        const scope = { ...job.scope, readOnly: !access.canEdit };
        const state = job.state();
        const key = JSON.stringify([4, rootId, scope, s.excludes, s.maxFileSizeMB, s.propagateDeletes, this.app.vault.configDir]);
        const indexed = rootId !== "root" && !access.inSharedDrive;
        const index = this.driveIndexes[job.id];
        const prefix = scope.localPrefix;
        const relative = (path: string) => prefix ? path.slice(prefix.length + 1) : path;
        const inScope = (path: string) => underPrefix(path, prefix) && path !== prefix &&
          !scope.otherPrefixes.some(other => underPrefix(path, other));
        const localPaths = new Set([...pending].filter(inScope).map(relative));
        if (this.rescanLocal && indexed && index?.key === key && !full) {
          const files = this.app.vault.getFiles();
          const seen = new Set(files.map(file => file.path));
          for (const file of files) {
            const previous = Object.prototype.hasOwnProperty.call(state, file.path) ? state[file.path] : undefined;
            if (inScope(file.path) && (!previous || file.stat.mtime !== previous.localMtime || file.stat.size !== previous.localSize)) {
              localPaths.add(relative(file.path));
            }
          }
          for (const path of Object.keys(state)) if (inScope(path) && !seen.has(path)) localPaths.add(relative(path));
        }
        hooks.transfer({ phase: 'listing', path: scope.remotePath });
        const feed = indexed && !full && index?.key === key ? await this.drive.changesSince(index.cursor) : null;
        const delta = feed && planDriveChanges(index, feed.changes, localPaths);
        // Capture the cursor before a full listing so later changes are replayed.
        const cursor = delta && feed ? feed.cursor : indexed ? await this.drive.changeCursor() : undefined;
        const tree = delta ? delta.tree : await this.drive.listTree(rootId);
        applying = true;
        const result = await runSync(this.app, this.drive, s, state, hooks, scope, {
          tree, paths: delta ? delta.affected : undefined,
          diskPaths: Platform.isDesktopApp ? new Set([...localPaths].map(path => prefix ? `${prefix}/${path}` : path)) : undefined,
        });
        add(result);
        if (!cursor || result.errors.length || tree.warnings.length) {
          delete this.driveIndexes[job.id];
        } else if (delta) {
          delta.commit(cursor, tree);
        } else {
          this.driveIndexes[job.id] = buildDriveIndex(key, cursor, tree);
        }
        applying = false;
        if (job.id === "main" && s.configSync.enabled) {
          if (!access.canEdit) total.warnings.push("Settings sync skipped: the whole-vault Drive folder is view-only for you.");
          else {
            const c = await runConfigSync(this.app, this.drive, s.configSync, rootId, this.configState, {
              propagateDeletes: s.propagateDeletes,
              maxBytes: Math.max(0, s.maxFileSizeMB) * 1024 * 1024,
            });
            total.uploaded += c.uploaded;
            total.downloaded += c.downloaded;
            total.deletedRemote += c.deleted;
            total.errors.push(...c.errors);
            total.needsRestart ||= c.needsRestart;
          }
        }
      } catch (e) {
        if (applying) delete this.driveIndexes[job.id];
        total.errors.push(`${job.scope.remotePath || "Drive folder"}: ${(e as Error).message}`);
      }
      await this.saveAll();
    }
    return total;
  }

  async sync(quiet: boolean, full = false) {
    if (this.syncing) {
      if (!quiet) new Notice("Sync already running.");
      return;
    }
    const s = this.settings;
    if (quiet && !full && !(Platform.isMobile && document.hidden) && Date.now() - this.lastLocalActivity < 5000) {
      this.queueSync(true);
      return;
    }
    if (!s.clientId || !s.clientSecret || !s.refreshToken) {
      if (!quiet) new Notice("GDSync: set up and sign in from the plugin settings first.");
      return;
    }
    this.syncing = true;
    const pending = this.pendingPaths;
    this.pendingPaths = new Set();
    full ||= this.forceFull;
    this.forceFull = false;
    this.inFlightPaths = pending;
    this.inFlightFull = full;
    let succeeded = false;
    this.syncInProgress = true;
    this.interruptedLastTime = false;
    try {
      this.activeProgress = new SyncProgress();
      this.renderProgress(true, !quiet);
      await this.saveAll();
      const r = await this.syncAllFolders(quiet, pending, full);
      if (!r.errors.length) {
        this.inFlightPaths = new Set();
        this.inFlightFull = false;
      }
      this.syncInProgress = false;
      await this.saveAll();
      succeeded = !r.errors.length;
      if (succeeded) this.rescanLocal = false;
      const parts: string[] = [];
      if (r.uploaded) parts.push(`↑${r.uploaded}`);
      if (r.downloaded) parts.push(`↓${r.downloaded}`);
      if (r.deletedLocal + r.deletedRemote) parts.push(`🗑${r.deletedLocal + r.deletedRemote}`);
      if (r.conflicts.length) parts.push(`⚠ ${r.conflicts.length} conflict(s)`);
      const summary = parts.length ? parts.join(" ") : r.errors.length ? "sync failed" : "up to date";
      this.setStatus(`GDSync: ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} ${r.errors.length ? "⚠" : "✓"}`);

      if (!quiet || parts.length || r.errors.length) new Notice(`GDSync: ${summary}`);
      if (r.conflicts.length) {
        new Notice(`Both sides changed; Drive's version saved as a "(conflict …)" copy:\n${r.conflicts.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.errors.length) {
        console.error("[gdsync] errors", r.errors);
        new Notice(`${r.errors.length} file(s) failed to sync. First: ${r.errors[0]}`, 15000);
      }
      if (r.readOnlyKept.length) {
        new Notice(`Local changes preserved at ${r.readOnlyKept.length} path(s):\n${r.readOnlyKept.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.needsRestart) {
        new Notice("GDSync: settings or plugins arrived from another device. Restart Obsidian to apply them.", 0);
      }
      if (r.skipped.length) {
        new Notice(`Skipped ${r.skipped.length} file(s) over ${s.maxFileSizeMB} MB:\n${r.skipped.slice(0, 5).join("\n")}`, 15000);
      }
      if (r.warnings.length) console.warn("[gdsync] warnings", r.warnings);
    } catch (e) {
      this.setStatus("GDSync: error");
      console.error("[gdsync]", e);
      new Notice(`GDSync failed: ${(e as Error).message}`, 15000);
    } finally {
      this.progressNotice?.hide();
      this.progressNotice = null;
      this.activeProgress = null;
      if (this.syncInProgress) {
        this.syncInProgress = false;
        await this.saveAll().catch(e => console.error('[gdsync] failed to save sync status', e));
      }
      this.inFlightPaths = new Set();
      this.inFlightFull = false;
      this.syncing = false;
      if (succeeded) {
        if (this.pendingPaths.size || this.forceFull) {
          if (Platform.isMobile && document.hidden) this.flushMobileQueue();
          else this.queueSync();
        }
      } else {
        for (const path of pending) this.pendingPaths.add(path);
        this.forceFull ||= full;
      }
    }
  }
}
