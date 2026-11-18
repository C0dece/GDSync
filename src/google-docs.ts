type Segment = {
  startIndex?: number;
  endIndex?: number;
  paragraph?: {
    bullet?: unknown;
    paragraphStyle?: Record<string, unknown>;
    elements?: {
      startIndex?: number;
      endIndex?: number;
      textRun?: { content?: string; textStyle?: Record<string, unknown> };
    }[];
  };
  sectionBreak?: unknown;
};
interface DocumentTab {
  tabProperties?: { tabId?: string };
  childTabs?: DocumentTab[];
  documentTab?: { body?: { content?: Segment[] } } & Record<string, unknown>;
}
export interface GoogleDocument {
  revisionId?: string;
  tabs?: DocumentTab[];
}

function hasSuggestions(value: unknown): boolean {
  return !!value && typeof value === 'object' && Object.entries(value as Record<string, unknown>).some(([key, child]) =>
    (key.startsWith('suggested') && !!child && typeof child === 'object' && Object.keys(child).length > 0) ||
    hasSuggestions(child));
}

export function plainMarkdown(data: ArrayBuffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n').replace(/\n+$/, '');
}

/** Keep Google structure intact: only plain text in a single tab is writable. */
export function planPlainDocEdit(doc: GoogleDocument, baseline: string, edited: string) {
  const tab = doc.tabs?.[0];
  const content = tab?.documentTab?.body?.content;
  const tabId = tab?.tabProperties?.tabId;
  const revision = doc.revisionId;
  const unsupported = () => new Error('Google Doc has formatting or structure that cannot be edited safely from Obsidian');
  if (!revision || !tabId || doc.tabs?.length !== 1 || tab?.childTabs?.length || !content || hasSuggestions(doc)) throw unsupported();
  for (const key of ['headers', 'footers', 'footnotes', 'lists', 'inlineObjects', 'positionedObjects', 'namedRanges']) {
    const entries = tab.documentTab?.[key];
    if (entries && typeof entries === 'object' && Object.keys(entries).length) throw unsupported();
  }

  let current = '';
  for (const [i, block] of content.entries()) {
    if (i === 0 && block.sectionBreak) continue;
    const p = block.paragraph;
    if (!p?.elements?.length || p.bullet || Object.entries(p.paragraphStyle ?? {}).some(([key, value]) =>
      !(key === 'namedStyleType' && value === 'NORMAL_TEXT') && !(key === 'direction' && value === 'LEFT_TO_RIGHT'))) throw unsupported();
    for (const item of p.elements) {
      const run = item.textRun;
      if (typeof run?.content !== 'string' || Object.keys(run.textStyle ?? {}).length ||
        item.startIndex !== current.length + 1 || item.endIndex !== current.length + 1 + run.content.length) throw unsupported();
      current += run.content;
    }
  }
  if (!current.endsWith('\n')) throw unsupported();
  current = current.slice(0, -1);
  if (current.replace(/\n+$/, '') !== baseline) throw unsupported();
  // Google silently strips some characters. Do not submit a write that would drop them.
  if (Array.from(edited).some(ch => {
    const code = ch.charCodeAt(0);
    return code <= 8 || (code >= 11 && code <= 31) || (code >= 0xe000 && code <= 0xf8ff);
  })) throw unsupported();
  if (edited.includes('[') || /[*_`\\\]<>]|^[ \t]*(?:#{1,6}\s|[-+]\s|\d+[.)]\s|[-=]{3,}[ \t]*$|~~~)/m.test(edited)) throw unsupported();

  const oldChars = Array.from(current);
  const newChars = Array.from(edited);
  let start = 0;
  while (start < oldChars.length && oldChars[start] === newChars[start]) start++;
  let oldEnd = oldChars.length;
  let newEnd = newChars.length;
  while (oldEnd > start && newEnd > start && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  const startIndex = oldChars.slice(0, start).join('').length + 1;
  const deleted = oldChars.slice(start, oldEnd).join('');
  const inserted = newChars.slice(start, newEnd).join('');
  const requests = [];
  if (deleted) requests.push({ deleteContentRange: { range: { startIndex, endIndex: startIndex + deleted.length, tabId } } });
  if (inserted) requests.push({ insertText: { location: { index: startIndex, tabId }, text: inserted } });
  return { writeControl: { requiredRevisionId: revision }, requests };
}
