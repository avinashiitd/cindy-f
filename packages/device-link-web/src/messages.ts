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
      if (text) result.push({ key, kind: row.role, text, createdAt: row.createdAt });
    } else if (row.role === 'tool_use') {
      result.push({ key, kind: 'tool', text: toolName(row.content), createdAt: row.createdAt });
    } else if (row.role === 'error' || row.role === 'system') {
      const text = contentText(row.content).trim();
      if (text) result.push({ key, kind: row.role, text, createdAt: row.createdAt });
    }
  }
  return result;
}
