/**
 * 测试价值
 * - 生产入口:用户粘贴的加入链接(三种写法)、被控端消息行的显示提取、浏览器 WebSocket 适配器。
 * - 规则依据:加入链接来自桌面端的 `cindy://relay/join?…`,网页也可能带 `#/join?…`;消息正文必须只作纯文本;
 *   浏览器的 `WebSocket.close` 对 1000/3000–4999 以外的关闭码会抛异常,而 DeviceLinkClient 会用 1001 等关闭。
 * - 现有覆盖缺口:端到端用例只走程序构造的链接和一条助手消息;这里补用户输入形态与异常关闭码。
 * - 附件:引用必须能被电脑端用共享解析器读回(ossKey、大小、SHA-256);落库时图片与文件分开,图片字段名必须是 originalName。
 * - tier:unit,无网络。
 */
import { buildRelayBrowserJoinLink, buildRelayJoinLink, createRelayPairSecret, createRelaySigningKey } from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import { describe, expect, it, vi } from 'vitest';

import { createHash } from 'node:crypto';
import { parseAttachmentOssRef } from '@cindy/device-link';

import { buildWebAttachment, hashBlob, persistedRefs } from '../attachments';
import { browserWsFactory } from '../connection';
import { parseJoinInput } from '../join';
import { toDisplayMessages } from '../messages';

describe('join input', () => {
  const baseUrl = 'https://relay.example.com';
  const desktopLink = buildRelayJoinLink({
    baseUrl, code: 'c'.repeat(32), ownerPublicKey: createRelaySigningKey(crypto).publicKey,
    pairSecret: createRelayPairSecret(crypto), app: 'cindy',
  });

  it('parses the browser link Desktop hands out exactly like the app link', () => {
    const params = { baseUrl: `${baseUrl}/`, code: 'd'.repeat(32), ownerPublicKey: createRelaySigningKey(crypto).publicKey, pairSecret: createRelayPairSecret(crypto) };
    const browser = buildRelayBrowserJoinLink(params);
    expect(browser.startsWith(`${baseUrl}/web/#/join?`)).toBe(true);
    expect(parseJoinInput(browser)).toEqual(parseJoinInput(buildRelayJoinLink({ ...params, app: 'cindy' })));
  });

  it('accepts the desktop link, the web fragment form, and rejects anything else', () => {
    const direct = parseJoinInput(desktopLink);
    expect(direct?.baseUrl).toBe(baseUrl);
    const fragment = parseJoinInput(`${baseUrl}/web/#/join?${desktopLink.split('?')[1]}`);
    expect(fragment).toEqual(direct);
    expect(parseJoinInput('https://relay.example.com/web/')).toBeNull();
    expect(parseJoinInput(desktopLink.replace('cindy://', 'evil://'))).toBeNull();
  });
});

describe('message display', () => {
  it('orders by time, unwraps stored user content, and hides tool results and thinking', () => {
    const shown = toDisplayMessages([
      { id: 'b', role: 'assistant', content: 'Done', createdAt: '2026-10-30T00:00:02Z' },
      { id: 'r', role: 'tool_result', content: 'secret output', createdAt: '2026-10-30T00:00:02Z' },
      { id: 't', role: 'thinking', content: 'hmm', createdAt: '2026-10-30T00:00:02Z' },
      { id: 'u', role: 'tool_use', content: JSON.stringify({ name: 'Bash', input: {} }), createdAt: '2026-10-30T00:00:01.500Z' },
      { id: 'a', role: 'user', content: JSON.stringify({ text: 'hi <script>', images: [] }), createdAt: '2026-10-30T00:00:01Z' },
    ]);
    expect(shown.map((m) => [m.kind, m.text])).toEqual([['user', 'hi <script>'], ['tool', 'Bash'], ['assistant', 'Done']]);
  });
});

describe('browser WebSocket adapter', () => {
  class FakeSocket {
    static last: FakeSocket;
    closed: unknown[][] = [];
    bufferedAmount = 0;
    constructor(readonly url: string, readonly protocols: string[]) { FakeSocket.last = this; }
    addEventListener() {}
    send() {}
    close(...args: unknown[]) {
      this.closed.push(args);
      if (args.length && ![1000].includes(args[0] as number) && ((args[0] as number) < 3000)) throw new Error('InvalidAccessError');
    }
  }

  it('moves the relay credential into the subprotocol and downgrades close codes browsers reject', async () => {
    const factory = browserWsFactory(FakeSocket as never);
    const credential = 'A'.repeat(43);
    const ws = await factory('wss://relay/api/device-link/ws', { authorization: `CindyRelay ${credential}` });
    expect(FakeSocket.last.protocols).toEqual(['cindy-relay.v1', `cindy-credential.${credential}`]);
    ws.close(1001, 'going away');
    ws.close(4410, 'removed');
    expect(FakeSocket.last.closed).toEqual([[], [4410, 'removed']]);
    expect(() => factory('wss://relay/x', { authorization: 'Bearer token' })).toThrow();
    vi.restoreAllMocks();
  });
});

describe('attachments', () => {
  it('hashes in chunks like a whole-file SHA-256 and builds references the host can parse', async () => {
    const bytes = new Uint8Array(9 * 1024 * 1024).map((_, i) => i % 251);
    const digest = await hashBlob(new Blob([bytes]));
    expect(digest).toBe(createHash('sha256').update(bytes).digest('hex'));

    const image = buildWebAttachment({ key: 'k1.png', name: 'C:\\shots\\screen.png', size: 10, sha256: digest, mimeType: 'image/png' });
    const doc = buildWebAttachment({ key: 'k2.pdf', name: 'spec.pdf', size: 20, sha256: digest, mimeType: 'application/pdf' });
    expect(parseAttachmentOssRef(image.path)).toMatchObject({ ossKey: 'k1.png', originalName: 'screen.png', size: 10, sha256: digest });
    expect([image.category, image.url === image.path, doc.category, doc.url]).toEqual(['image', true, 'pdf', undefined]);
    const refs = persistedRefs([image, doc]);
    expect(refs.images).toEqual([{ url: image.path, originalName: 'screen.png', mimeType: 'image/png', size: 10, sha256: digest }]);
    expect(refs.files).toEqual([{ name: 'spec.pdf', path: doc.path, size: 20, sha256: digest }]);
  });
});
