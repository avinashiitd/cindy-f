/**
 * 把被控端的消息行转成网页上显示的文字。只做保守的纯文本提取:用户消息、助手回复、工具调用名、错误;
 * 思考、工具结果等不显示。所有文字都以 textContent 写入页面,不会被当成 HTML。
 */

export interface RemoteMessageRow {
  id: string;
  clientId?: string;
  role: string;
  content: unknown;
  createdAt: string;
  rowid?: number;
}

export type DisplayKind = 'user' | 'assistant' | 'tool' | 'error' | 'system';

export interface DisplayMessage {
  key: string;
  kind: DisplayKind;
  text: string;
  /** 工具调用的一行摘要(命令、路径、网址等)。 */
  detail?: string;
  /** 用户消息附带的图片 / 文件名。 */
  attachments?: string[];
  createdAt: string;
}

function tryParseObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function blocksText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .map((block) => (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string'
      ? (block as { text: string }).text
      : ''))
    .filter(Boolean)
    .join('\n');
}

function contentText(content: unknown): string {
  if (typeof content === 'string') {
    const parsed = tryParseObject(content);
    if (parsed) return contentText(parsed);
    return content;
  }
  if (Array.isArray(content)) return blocksText(content);
  const record = tryParseObject(content);
  if (!record) return '';
  if (typeof record.text === 'string') return record.text;
  if (typeof record.message === 'string') return record.message;
  return blocksText(record.content);
}

function attachmentNames(content: unknown): string[] {
  const record = tryParseObject(content);
  if (!record) return [];
  const names: string[] = [];
  for (const list of [record.images, record.files]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const name = item && typeof item === 'object' ? ((item as { originalName?: unknown; name?: unknown }).originalName ?? (item as { name?: unknown }).name) : null;
      if (typeof name === 'string' && name.trim()) names.push(name.trim());
    }
  }
  return names.slice(0, 20);
}

function toolDetail(content: unknown): string | undefined {
  const input = tryParseObject(tryParseObject(content)?.input);
  if (!input) return undefined;
  for (const key of ['command', 'file_path', 'path', 'url', 'pattern', 'query', 'description']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().split('\n')[0].slice(0, 160);
  }
  return undefined;
}

function toolName(content: unknown): string {
  const record = tryParseObject(content);
  const name = record?.name ?? record?.toolName;
  return typeof name === 'string' && name ? name : 'tool';
}

export function toDisplayMessages(rows: readonly RemoteMessageRow[]): DisplayMessage[] {
  const ordered = [...rows].sort((a, b) => {
    const byTime = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (byTime !== 0 && Number.isFinite(byTime)) return byTime;
    return (a.rowid ?? 0) - (b.rowid ?? 0);
  });
  const result: DisplayMessage[] = [];
  for (const row of ordered) {
    const key = row.id || row.clientId || `${row.createdAt}:${result.length}`;
    if (row.role === 'user' || row.role === 'assistant') {
      const text = contentText(row.content).trim();
      const attachments = row.role === 'user' ? attachmentNames(row.content) : [];
      if (text || attachments.length) result.push({ key, kind: row.role, text, createdAt: row.createdAt, ...(attachments.length ? { attachments } : {}) });
    } else if (row.role === 'tool_use') {
      result.push({ key, kind: 'tool', text: toolName(row.content), detail: toolDetail(row.content), createdAt: row.createdAt });
    } else if (row.role === 'error' || row.role === 'system') {
      const text = contentText(row.content).trim();
      if (text) result.push({ key, kind: row.role, text, createdAt: row.createdAt });
    }
  }
  return result;
}
