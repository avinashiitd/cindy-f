/**
 * 测试价值
 * - 生产入口与可观察结果:真实 `startRelayServer` + 网页控制端的加入(`joinRelay`)、连接(`createWebConnection` 用
 *   Node 内置的浏览器式 `WebSocket`,凭证走 Sec-WebSocket-Protocol)、`RemoteApi` 读写;另一端是按 Desktop 的
 *   device-link 行为(link-accept / invoke-result)应答的被控端,两端都开启设备签名。
 * - Bug/规则依据:浏览器 WebSocket 不能设置 Authorization 头;浏览器没有 Cindy 账号;经中转的每条对端消息必须带签名
 *   (docs/self-hosted-relay-plan.md §5、§8、§16)。
 * - 现有覆盖缺口:中转与共享客户端各自有测试,没有任何用例用「浏览器式」握手和 web 加入流程走通到被控端。
 * - 最小失败输入:错误的凭证子协议应被拒;没有 platform=web 的缺省账号应被拒;审批、发送的 wire 内容要与手机一致。
 * - tier:unit(本机回环端口 + 临时目录,无外部服务)。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  buildRelayJoinLink,
  createRelayPairSecret,
  createRelaySigningKey,
  DeviceLinkClient,
  fetchRelayCertificates,
  issueRelayDeviceCert,
  parseRelayJoinLink,
  RelayFrameAuthenticator,
  type Envelope,
  type InvokePayload,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto as nodeCrypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, initializeRelay, startRelayServer, type RelayServerHandle } from '@cindy/device-link-relay';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { browserWsFactory, createWebConnection } from '../connection';
import { webRelayAuthCrypto } from '../crypto';
import { joinRelay } from '../join';
import { RemoteApi } from '../remote';

const OWNER_DEVICE = 'owner-desktop';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function ownerRequest(base: string, credential: string, method: string, pathname: string, body?: unknown) {
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers: { authorization: `CindyRelay ${credential}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return (await res.json()) as any;
}

/** 起中转 + 模拟被控的 Desktop(主人电脑)。 */
async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-web-e2e-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(nodeCrypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir, name: 'Home relay', ownerUserId: 'user-owner', ownerDeviceId: OWNER_DEVICE, ownerDeviceName: 'Owner Mac',
    ownerCredentialHash: owner.credentialHash, relayId, ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(nodeCrypto, ownerKey.seed, {
      relayId, deviceId: OWNER_DEVICE, publicKey: ownerKey.publicKey, role: 'owner', issuedAt: 1,
    }),
  });
  const handle: RelayServerHandle = await startRelayServer({ dataDir, port: 0, webClient: false });
  cleanups.push(async () => { await handle.close(); await rm(dataDir, { recursive: true, force: true }); });
  const base = handle.localUrl;

  // 被控端:与 Desktop 相同的 device-link 行为,开启设备签名。
  const authenticator = new RelayFrameAuthenticator({
    crypto: nodeCrypto, relayId, deviceId: OWNER_DEVICE, seed: ownerKey.seed, ownerPublicKey: ownerKey.publicKey,
    // Desktop 同样在遇到不认识的设备时刷新证书列表。
    onUnknownSigner: () => void refreshCerts(),
  });
  const refreshCerts = async () => authenticator.setCertificates(
    await fetchRelayCertificates((url, init) => fetch(url, init), base, owner.credential));
  await refreshCerts();
  const host = new DeviceLinkClient({
    getWsUrl: () => `${base.replace(/^http/, 'ws')}/api/device-link/ws`,
    getToken: async () => owner.credential,
    authorizationScheme: 'CindyRelay',
    frameAuth: () => ({
      peerChallenge: { session: authenticator, state: (id) => authenticator.peerChallenge(id) },
      sign: (frame) => authenticator.sign(frame),
      verify: (frame) => {
        const verdict = authenticator.verify(frame);
        if (verdict === 'bad-signature') void refreshCerts();
        return verdict === 'ok';
      },
    }),
    getHello: () => ({ deviceName: 'Owner Mac', platform: 'darwin', appVersion: '1.0.0', remoteControlEnabled: true, busy: false }),
    createWebSocket: (url, headers) => new WebSocket(url, { headers }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const calls: Array<{ channel: string; args: unknown[] }> = [];
  const session = {
    id: 's1', title: 'Fix the build', status: 'active', model: 'claude-sonnet', workingDir: '/repo', permissionMode: 'ask',
    effort: 'high', agentKind: 'cc', updatedAt: '2026-10-30T00:00:00.000Z',
  };
  host.onFrame((env: Envelope) => {
    if (!env.src || !env.id) return;
    if (env.kind === 'link-open') {
      host.sendLinkAccept(env.src, env.id, { appVersion: '1.0.0', allowlistHash: 'test' });
      return;
    }
    if (env.kind !== 'invoke') return;
    const { channel, args } = env.payload as InvokePayload;
    calls.push({ channel, args });
    const reply = (result: unknown) => host.sendInvokeResult(env.src!, env.id!, { ok: true, result });
    switch (channel) {
      case 'local-db:sessions:list': return reply([session]);
      case 'local-db:sessions:get': return reply(session);
      case 'local-db:messages:list':
        return reply([
          { id: 'm2', role: 'assistant', content: 'Done.', createdAt: '2026-10-30T00:00:02.000Z' },
          { id: 'm1', role: 'user', content: JSON.stringify({ text: 'build fails', images: [], files: [] }), createdAt: '2026-10-30T00:00:01.000Z' },
        ]);
      case 'maker:get-pending-interactions':
        return reply([{ request: { kind: 'permission', requestId: 'req-1', toolName: 'Bash' } }]);
      default: return reply({ ok: true });
    }
  });
  host.start();
  cleanups.push(() => host.stop());
  await vi.waitFor(() => expect(host.getStatus()).toBe('online'), { timeout: 5_000 });
  return { base, relayId, owner, ownerKey, calls };
}

async function webJoin(env: Awaited<ReturnType<typeof setup>>) {
  const { code } = await ownerRequest(env.base, env.owner.credential, 'POST', '/api/device-link/relay/admin/join-codes');
  const link = parseRelayJoinLink(buildRelayJoinLink({
    baseUrl: env.base, code, ownerPublicKey: env.ownerKey.publicKey, pairSecret: createRelayPairSecret(nodeCrypto), app: 'cindy',
  }))!;
  const verifyCodes: string[] = [];
  const joined = joinRelay({
    link, deviceName: 'Chrome (web)', fetchFn: (url, init) => fetch(url, init), crypto: webRelayAuthCrypto,
    onVerifyCode: (c) => verifyCodes.push(c),
  });
  // 主人电脑:看到申请后核对并同意,附上为这把公钥签发的证书。
  let request: any;
  await vi.waitFor(async () => {
    const pending = await ownerRequest(env.base, env.owner.credential, 'GET', '/api/device-link/relay/admin/pair-requests');
    request = pending.requests[0];
    expect(request).toBeDefined();
  }, { timeout: 5_000 });
  expect(request.platform).toBe('web');
  expect(request.verifyCode).toBe(verifyCodes[0]);
  await ownerRequest(env.base, env.owner.credential, 'POST', `/api/device-link/relay/admin/pair-requests/${request.requestId}/approve`, {
    cert: issueRelayDeviceCert(nodeCrypto, env.ownerKey.seed, {
      relayId: env.relayId, deviceId: request.deviceId, publicKey: request.publicKey, role: 'member', issuedAt: 2,
    }),
  });
  return joined;
}

describe('browser control end to end', () => {
  it('joins without an account, connects with a browser-style handshake and drives the host', async () => {
    const env = await setup();
    const profile = await webJoin(env);
    expect(profile).toMatchObject({ relayId: env.relayId, baseUrl: env.base, deviceName: 'Chrome (web)' });
    expect(profile.deviceId).toMatch(/^web-[0-9a-f]{32}$/);

    // Node 内置的 WebSocket 与浏览器一样:不能设置头,只能走子协议。
    const connection = createWebConnection(profile, { createWebSocket: browserWsFactory(globalThis.WebSocket as never) });
    cleanups.push(() => connection.stop());
    await vi.waitFor(() => expect(connection.client.getStatus()).toBe('online'), { timeout: 5_000 });

    const api = new RemoteApi(connection.client, profile.baseUrl, profile.credential, profile.deviceName);
    const devices = await api.listDevices();
    const host = devices.find((device) => device.deviceId === OWNER_DEVICE)!;
    expect(host).toMatchObject({ online: true, remoteControlEnabled: true });

    const sessions = await api.listSessions(OWNER_DEVICE);
    expect(sessions.map((s) => s.title)).toEqual(['Fix the build']);

    await api.openLink(OWNER_DEVICE);
    await api.subscribe(OWNER_DEVICE, ['session:s1']);
    const messages = await api.listMessages(OWNER_DEVICE, 's1');
    expect(messages).toHaveLength(2);

    const pending = await api.listPendingInteractions(OWNER_DEVICE, 's1');
    await api.resolvePermission(OWNER_DEVICE, pending[0].request.requestId!, 'allow');
    await api.sendText(OWNER_DEVICE, sessions[0], '  run the tests  ', 'client-1');
    await api.stop(OWNER_DEVICE, 's1');

    const byChannel = (channel: string) => env.calls.filter((call) => call.channel === channel);
    expect(byChannel('device-link:subscribe')[0].args[0]).toMatchObject({ topics: ['session:s1'] });
    expect(byChannel('maker:resolve-interaction')[0].args).toEqual(['req-1', { kind: 'permission', behavior: 'allow' }]);
    const [sessionId, item, opts] = byChannel('maker:input:enqueue')[0].args as [string, any, any];
    expect(sessionId).toBe('s1');
    expect(item).toMatchObject({
      clientId: 'client-1', text: 'run the tests', model: 'claude-sonnet', permissionMode: 'ask', workingDir: '/repo',
      chatMessage: { clientId: 'client-1', role: 'user', content: 'run the tests' },
      createOpts: { agentKind: 'claude-code', workingDir: '/repo' },
    });
    expect(JSON.parse(item.persistedContent)).toEqual({ text: 'run the tests', images: [], files: [] });
    expect(typeof opts.sendAtMs).toBe('number');
    expect(byChannel('maker:input:stop')[0].args).toEqual(['s1', {}]);

    // 新建任务与运行设置:wire 与手机一致。
    await api.createSession(OWNER_DEVICE, { id: 'n1', agentKind: 'codex', workspaceKind: 'project', model: 'gpt', providerId: 'oa', permissionMode: 'plan', fastMode: false, workingDir: '/repo' });
    await api.setModel(OWNER_DEVICE, 's1', 'opus', 'anthropic');
    await api.setPermissionMode(OWNER_DEVICE, 's1', 'acceptEdits');
    await api.answerQuestions(OWNER_DEVICE, 'q1', { 'Which DB?': 'postgres' });
    await api.resolvePlan(OWNER_DEVICE, 'p1', false, '# plan', '  shorter please ');
    expect(byChannel('maker:create-session')[0].args[0]).toMatchObject({ id: 'n1', agentKind: 'codex', model: 'gpt', providerId: 'oa', workingDir: '/repo' });
    expect(byChannel('maker:set-model')[0].args).toEqual(['s1', 'opus', 'anthropic']);
    expect(byChannel('maker:set-permission-mode')[0].args).toEqual(['s1', 'acceptEdits']);
    const decisions = byChannel('maker:resolve-interaction').map((call) => call.args);
    expect(decisions).toContainEqual(['q1', { kind: 'ask_user_question', answers: { 'Which DB?': 'postgres' } }]);
    expect(decisions).toContainEqual(['p1', { kind: 'plan_review', behavior: 'deny', editedPlan: undefined, reason: 'shorter please' }]);

    // 刷新页面 = 同一浏览器身份的新连接。被控端仍按旧连接的可靠传输回复;
    // 新页面必须重建控制链路,否则回复被丢弃、列表一直加载不出来(曾经的缺陷)。
    connection.stop();
    const reloaded = createWebConnection(profile, { createWebSocket: browserWsFactory(globalThis.WebSocket as never) });
    cleanups.push(() => reloaded.stop());
    const reloadedApi = new RemoteApi(reloaded.client, profile.baseUrl, profile.credential, profile.deviceName);
    const again = await reloadedApi.listSessions(OWNER_DEVICE);
    expect(again.map((s) => s.id)).toEqual(['s1']);
  }, 30_000);

  it('rejects a browser handshake with the wrong credential or without the version marker', async () => {
    const env = await setup();
    const url = `${env.base.replace(/^http/, 'ws')}/api/device-link/ws`;
    const attempt = (protocols: string[]) => new Promise<'open' | 'rejected'>((resolve) => {
      const ws = new globalThis.WebSocket(url, protocols);
      ws.addEventListener('open', () => { ws.close(); resolve('open'); });
      ws.addEventListener('error', () => resolve('rejected'));
    });
    expect(await attempt(['cindy-relay.v1', `cindy-credential.${'A'.repeat(43)}`])).toBe('rejected');
    // 凭证对、但缺版本标记:不当作认证。
    expect(await attempt([`cindy-credential.${env.owner.credential}`])).toBe('rejected');
    expect(await attempt(['cindy-relay.v1', `cindy-credential.${env.owner.credential}`])).toBe('open');
  }, 15_000);
});
