import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Platform, TFile } from 'obsidian';
import GSyncPlugin from '../src/main';

test('status button syncs on desktop and local edits queue one run without an interval', async () => {
  const callbacks = new Map<string, (...args: any[]) => void>();
  const scheduled = new Map<number, () => void>();
  let nextTimer = 0;
  const runtime = globalThis as any;
  runtime.window = {
    setTimeout: (callback: () => void) => { scheduled.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: (id: number) => scheduled.delete(id),
    setInterval: () => assert.fail('event based mode started an interval'),
  };
  runtime.document = { hidden: false };
  let saved: any;
  const button = { setText() {} };
  const plugin = Object.assign(new GSyncPlugin(), {
    app: {
      vault: {
        configDir: '.obsidian', getName: () => 'Test',
        on: (event: string, callback: (...args: any[]) => void) => callbacks.set(event, callback),
      },
      workspace: { onLayoutReady: (callback: () => void) => callback() },
    },
    loadData: async () => ({ settings: {
      refreshToken: 'fake', syncOnChanges: true, syncOnStartup: false, showSyncNotifications: false,
    } }),
    saveData: async (data: unknown) => { saved = structuredClone(data); },
    addStatusBarItem: () => ({ ...button, createEl: (tag: string) => { assert.equal(tag, 'button'); return button; } }),
    registerDomEvent: (element: unknown, event: string, callback: () => void) => {
      if (event === 'click') assert.equal(element, button);
      callbacks.set(event, callback);
    },
    addSettingTab() {}, addRibbonIcon() {}, addCommand() {}, register() {}, registerEvent() {}, registerObsidianProtocolHandler() {},
  });
  const runs: boolean[] = [];
  plugin.sync = async (quiet: boolean) => { runs.push(quiet); };
  try {
    await plugin.onload();
    callbacks.get('click')!();
    assert.deepEqual(runs, [false]);
    scheduled.clear();
    const file = Object.assign(new TFile(), { path: 'note.md' });
    callbacks.get('modify')!(file);
    callbacks.get('modify')!(file);
    assert.equal(scheduled.size, 1);
    scheduled.values().next().value!();
    assert.deepEqual(runs, [false, true]);
    Object.assign(Platform, { isMobile: true });
    runtime.noticeMock = () => assert.fail('disabled progress popup was shown');
    Object.assign(plugin, { activeProgress: { text: () => 'Progress' } });
    (plugin as any).renderProgress(true, true);
    scheduled.clear();
    callbacks.get('modify')!(Object.assign(new TFile(), { path: 'mobile.md' }));
    runtime.document.hidden = true;
    callbacks.get('visibilitychange')!();
    assert.deepEqual(runs, [false, true, true]);
    assert.equal(scheduled.size, 0, 'hiding the app bypasses the debounce');
    await (plugin as any).saveTail;
    assert.ok(saved.pendingLocalPaths.includes('mobile.md'));

    Object.assign(plugin, { loadData: async () => saved });
    await plugin.onload();
    assert.equal(scheduled.size, 1, 'the saved queue resumes even with startup sync turned off');
  } finally {
    Object.assign(Platform, { isMobile: false });
    delete runtime.window;
    delete runtime.document;
    delete runtime.noticeMock;
  }
});
