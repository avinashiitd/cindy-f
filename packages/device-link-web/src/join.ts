/**
 * 加入流程(浏览器版):与电脑、手机同一套共享函数 —— 探测中转、提交申请、等主人同意、核对主人签发的证书。
 * 浏览器没有 Cindy 账号,申请里不带账号 ID(中转只对 platform=web 放行);准入仍由加入码、
 * 链接里的配对秘密和主人在电脑上的确认把关。
 */
import {
  acceptRelayDeviceCert,
  createRelayJoinIdentity,
  fetchRelayInfo,
  parseRelayJoinLink,
  submitRelayPairRequest,
  waitForRelayApproval,
  RelayJoinError,
  type RelayAuthCrypto,
  type RelayFetch,
} from '@cindy/device-link';

import { createWebDeviceId } from './crypto';
import type { WebRelayProfile } from './profile';

export const WEB_APP_VERSION = '0.1.0';

/** 页面地址里 `#/join?u=…&c=…&o=…&s=…` 或粘贴的 `cindy://relay/join?…` 都接受。 */
export function parseJoinInput(value: string): ReturnType<typeof parseRelayJoinLink> {
  const trimmed = value.trim();
  const hashIndex = trimmed.indexOf('#/join?');
  if (hashIndex >= 0) return parseRelayJoinLink(`/relay${trimmed.slice(hashIndex + 1)}`);
  return parseRelayJoinLink(trimmed);
}

export interface JoinRelayInput {
  link: NonNullable<ReturnType<typeof parseRelayJoinLink>>;
  deviceName: string;
  fetchFn: RelayFetch;
  crypto: RelayAuthCrypto;
  /** 申请提交后立即回调:界面显示核对码,主人在电脑上核对后同意。 */
  onVerifyCode?: (code: string) => void;
  signal?: AbortSignal;
  deviceId?: string;
}

export async function joinRelay(input: JoinRelayInput): Promise<WebRelayProfile> {
  const { link, fetchFn, crypto, signal } = input;
  const info = await fetchRelayInfo(fetchFn, link.baseUrl, signal);
  const deviceId = input.deviceId ?? createWebDeviceId(crypto.randomBytes);
  const identity = createRelayJoinIdentity(crypto, link, info.relayId, deviceId);
  const request = await submitRelayPairRequest(
    fetchFn,
    link,
    {
      deviceId,
      deviceName: input.deviceName,
      platform: 'web',
      appVersion: WEB_APP_VERSION,
      publicKey: identity.publicKey,
      proof: identity.proof,
    },
    signal,
  );
  input.onVerifyCode?.(request.verifyCode);
  const result = await waitForRelayApproval(fetchFn, link, request, { signal });
  // 中转转交的证书必须出自链接里的主人、发给这把公钥;否则说明中转可能被人替换。
  try {
    acceptRelayDeviceCert(crypto, link, {
      relayId: info.relayId,
      deviceId: result.deviceId,
      publicKey: identity.publicKey,
      cert: result.cert,
    });
  } catch (error) {
    if (error instanceof RelayJoinError) throw error;
    throw new RelayJoinError('OWNER_MISMATCH', 'the relay returned an invalid certificate');
  }
  return {
    version: 1,
    relayId: info.relayId,
    name: info.name,
    baseUrl: link.baseUrl,
    deviceId: result.deviceId,
    deviceName: input.deviceName.slice(0, 64),
    ownerPublicKey: link.ownerPublicKey,
    credential: result.credential,
    seed: identity.seed,
  };
}
