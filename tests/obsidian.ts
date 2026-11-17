export const Platform = { isAndroidApp: true };
export class TFile {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Notice {
  constructor(message: string) { (globalThis as any).noticeMock?.(message); }
}
export const requestUrl = (options: unknown) => (globalThis as any).requestUrlMock(options);
