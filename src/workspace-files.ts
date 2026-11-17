import type { RemoteFile } from './drive';

const formats: Readonly<Record<string, { extension: string; mimeType: string }>> = {
  'application/vnd.google-apps.document': { extension: '.md', mimeType: 'text/markdown' },
  'application/vnd.google-apps.spreadsheet': {
    extension: '.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  },
  'application/vnd.google-apps.presentation': {
    extension: '.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  },
  'application/vnd.google-apps.drawing': { extension: '.pdf', mimeType: 'application/pdf' },
  'application/vnd.google-apps.script': { extension: '.json', mimeType: 'application/vnd.google-apps.script+json' },
};

export function workspaceFormat(file: RemoteFile) {
  return Object.prototype.hasOwnProperty.call(formats, file.mimeType) ? formats[file.mimeType] : undefined;
}

export function syncFileName(file: RemoteFile): string | undefined {
  if (!file.name || file.name.startsWith('.')) return;
  const format = workspaceFormat(file);
  if (!format) return file.mimeType.startsWith('application/vnd.google-apps.') ? undefined : file.name;
  if (!/^[A-Za-z0-9_-]+$/.test(file.id)) return;
  const name = file.name.toLowerCase().endsWith(format.extension)
    ? file.name.slice(0, -format.extension.length) : file.name;
  const safe = Array.from(name.replace(/[<>:"/\\|?*]/g, '_')).slice(0, 80).join('').trim().replace(/\.+$/, '');
  return `${safe || 'Untitled'} (Google ${file.id})${format.extension}`;
}
