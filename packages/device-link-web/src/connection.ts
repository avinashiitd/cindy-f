/**
 * 浏览器到自建中转的 device-link 连接:同一个 `DeviceLinkClient`,换上浏览器的 WebSocket。
 *
 * - 浏览器的 WebSocket 不能设置 Authorization 头,凭证放在 `Sec-WebSocket-Protocol`
 *   (`cindy-relay.v1` + `cindy-credential.<凭证>`),中转据此认证;其余协议、重连、心跳、可靠传输与电脑/手机一致。
 * - 经中转转发的每条对端消息都带设备签名(`frameAuth`),收到的消息核对证书和签名,不通过的丢弃 ——
 *   即使中转所在服务器被人控制,也无法冒充这个浏览器或伪造电脑发来的审批文案。
 */
import {
  DeviceLinkClient,
  fetchRelayCertificates,
  PROTOCOL_VERSION,
  RelayFrameAuthenticator,
  type DeviceLinkFrameAuth,
  type RelayFetch,
  type WsFactory,
  type WsLike,
} from '@cindy/device-link';

import { webRelayAuthCrypto } from './crypto';
import { WEB_APP_VERSION } from './join';
import type { WebRelayProfile } from './profile';

export const RELAY_WS_SUBPROTOCOL = 'cindy-relay.v1';
export const RELAY_WS_CREDENTIAL_PREFIX = 'cindy-credential.';
const CERT_REFRESH_INTERVAL_MS = 10 * 60 * 1000;
const SIGNER_REFRESH_MIN_MS = 5_000;

export function relayWsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/^http/i, 'ws')}/api/device-link/ws`;
}

type WebSocketCtor = new (url: string, protocols?: string | string[]) => WebSocket;

/** `DeviceLinkClient` 传来的 `authorization: CindyRelay <凭证>` 改成浏览器能发的子协议。 */
export function browserWsFactory(Impl: WebSocketCtor = WebSocket): WsFactory {
  return (url, headers): WsLike => {
    const header = Object.entries(headers).find(([name]) => name.toLowerCase() === 'authorization')?.[1] ?? '';
    const credential = /^CindyRelay (\S+)$/.exec(header)?.[1];
    if (!credential) throw new Error('relay credential missing');
    const ws = new Impl(url, [RELAY_WS_SUBPROTOCOL, `${RELAY_WS_CREDENTIAL_PREFIX}${credential}`]);
    const closeSafely = (code?: number, reason?: string) => {
      try {
        // 浏览器只允许 1000 与 3000–4999;其余关闭码退回默认关闭。
        if (code === 1000 || (code !== undefined && code >= 3000 && code <= 4999)) ws.close(code, reason);
        else ws.close();
      } catch {
        // 已经关闭。
      }
    };
    return {
      send: (data) => ws.send(data),
      close: closeSafely,
      terminate: () => closeSafely(),
      get bufferedAmount() {
        return ws.bufferedAmount;
      },
      on(event: string, cb: (...args: never[]) => void) {
        const listener = cb as (...args: unknown[]) => void;
        if (event === 'open') ws.addEventListener('open', () => listener());
        else if (event === 'message') ws.addEventListener('message', (e) => listener({ toString: () => String(e.data) }));
        else if (event === 'close') ws.addEventListener('close', (e) => listener(e.code, e.reason));
        else if (event === 'error') ws.addEventListener('error', () => listener(new Error('websocket error')));
      },
    } as WsLike;
  };
}

export interface WebConnection {
  readonly client: DeviceLinkClient;
  readonly profile: WebRelayProfile;
  stop(): void;
}

export interface WebConnectionDeps {
  fetchFn?: RelayFetch;
  createWebSocket?: WsFactory;
  now?: () => number;
}

export function createWebConnection(profile: WebRelayProfile, deps: WebConnectionDeps = {}): WebConnection {
  const fetchFn: RelayFetch = deps.fetchFn ?? ((url, init) => fetch(url, init));
  const authenticator = new RelayFrameAuthenticator({
    crypto: webRelayAuthCrypto,
    relayId: profile.relayId,
    deviceId: profile.deviceId,
    seed: profile.seed,
    ownerPublicKey: profile.ownerPublicKey,
    now: deps.now,
    onUnknownSigner: () => refreshCertificates(SIGNER_REFRESH_MIN_MS),
  });

  let lastRefreshAt = -Infinity;
  let refreshing: Promise<void> | null = null;
  let stopped = false;
  const refreshCertificates = (minIntervalMs: number): void => {
    const now = Date.now();
    if (stopped || refreshing || now - lastRefreshAt < minIntervalMs) return;
    lastRefreshAt = now;
    refreshing = (async () => {
      try {
        const certs = await fetchRelayCertificates(fetchFn, profile.baseUrl, profile.credential);
        if (!stopped) authenticator.setCertificates(certs);
      } catch {
        // 取不到证书时,未核对的消息继续被拒绝;下次有消息到来或定时器触发再试。
      }
    })().finally(() => {
      refreshing = null;
    });
  };

  const frameAuth: DeviceLinkFrameAuth = {
    peerChallenge: { session: authenticator, state: (deviceId) => authenticator.peerChallenge(deviceId) },
    sign: (frame) => authenticator.sign(frame),
    verify: (frame) => {
      const verdict = authenticator.verify(frame);
      if (verdict === 'bad-signature') refreshCertificates(SIGNER_REFRESH_MIN_MS);
      return verdict === 'ok';
    },
  };

  const client = new DeviceLinkClient({
    getWsUrl: () => relayWsUrl(profile.baseUrl),
    getToken: async () => profile.credential,
    authorizationScheme: 'CindyRelay',
    frameAuth: () => frameAuth,
    getHello: () => ({
      deviceName: profile.deviceName,
      platform: 'web',
      appVersion: WEB_APP_VERSION,
      // 浏览器只做控制端,不接受别人控制。
      remoteControlEnabled: false,
      busy: false,
    }),
    createWebSocket: deps.createWebSocket ?? browserWsFactory(),
  });

  refreshCertificates(0);
  const timer = setInterval(() => refreshCertificates(CERT_REFRESH_INTERVAL_MS), CERT_REFRESH_INTERVAL_MS);
  client.start();

  return {
    client,
    profile,
    stop() {
      stopped = true;
      clearInterval(timer);
      client.stop();
    },
  };
}

export { PROTOCOL_VERSION };
