/**
 * 消息附件(浏览器版):文件先上传到自建中转的媒体存储,再以附件引用随消息发给电脑,电脑自己下载。
 * 引用格式与手机一致(`buildLegacyAttachmentOssRef`,混合版本期间仍用旧 scheme),带大小与 SHA-256 完整性声明。
 */
import { buildLegacyAttachmentOssRef } from '@cindy/device-link';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

/** 浏览器端一次上传的上限:整个文件要在页面里算哈希,太大会卡住标签页。 */
export const WEB_ATTACHMENT_MAX_BYTES = 200 * 1024 * 1024;
const HASH_CHUNK_BYTES = 4 * 1024 * 1024;

export type AttachmentCategory = 'image' | 'pdf' | 'text' | 'office' | 'file';

export interface WebAttachment {
  id: string;
  name: string;
  path: string;
  ext: string;
  size: number;
  sha256: string;
  category: AttachmentCategory;
  mimeType: string;
  url?: string;
  originalName: string;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);
const OFFICE_EXTS = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx']);
const TEXT_EXTS = new Set(['txt', 'md', 'json', 'csv', 'log', 'yaml', 'yml', 'xml', 'html', 'css', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'h', 'cpp', 'sh', 'sql', 'toml', 'ini']);

export function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16) : '';
}

export function categoryOf(name: string, mimeType: string): AttachmentCategory {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext) && mimeType.startsWith('image/')) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (OFFICE_EXTS.has(ext)) return 'office';
  if (TEXT_EXTS.has(ext) || mimeType.startsWith('text/')) return 'text';
  return 'file';
}

/** 分块计算 SHA-256,块之间让出主线程,大文件也不会让页面失去响应。 */
export async function hashBlob(blob: Blob): Promise<string> {
  const hash = sha256.create();
  for (let offset = 0; offset < blob.size; offset += HASH_CHUNK_BYTES) {
    hash.update(new Uint8Array(await blob.slice(offset, offset + HASH_CHUNK_BYTES).arrayBuffer()));
  }
  return bytesToHex(hash.digest());
}

export function buildWebAttachment(input: { key: string; name: string; size: number; sha256: string; mimeType: string }): WebAttachment {
  const name = input.name.split(/[\\/]/).pop()!.trim() || 'file';
  const mimeType = input.mimeType || 'application/octet-stream';
  const category = categoryOf(name, mimeType);
  const ref = buildLegacyAttachmentOssRef({ ossKey: input.key, mimeType, originalName: name, size: input.size, sha256: input.sha256 });
  return {
    id: `web-upload:${input.key}`, name, path: ref, ext: extOf(name), size: input.size, sha256: input.sha256,
    category, mimeType, ...(category === 'image' ? { url: ref } : {}), originalName: name,
  };
}

/** 落库的用户消息内容里,图片与文件分开写(字段名与桌面、手机一致:图片用 originalName)。 */
export function persistedRefs(attachments: readonly WebAttachment[]) {
  return {
    images: attachments.filter((a) => a.category === 'image')
      .map((a) => ({ url: a.url || a.path, originalName: a.originalName, mimeType: a.mimeType, size: a.size, sha256: a.sha256 })),
    files: attachments.filter((a) => a.category !== 'image')
      .map((a) => ({ name: a.name, path: a.path, size: a.size, sha256: a.sha256 })),
  };
}
