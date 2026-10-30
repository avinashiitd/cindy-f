/**
 * 这个浏览器加入的中转:保存在 localStorage。
 *
 * 凭证与签名种子只对这一个中转有效、不含 Cindy 账号信息;页面由中转同源提供并带严格 CSP(不执行内联脚本),
 * 但浏览器存储终究比系统安全存储弱,所以界面提供「退出此中转」,并在加入页说明:公共电脑不要加入。
 */
import { isRelayPublicKey, normalizeRelayBaseUrl } from '@cindy/device-link';

export interface WebRelayProfile {
  version: 1;
  relayId: string;
  name: string;
  baseUrl: string;
  /** 加入时分配的设备 ID(= 证书里的 deviceId)。 */
  deviceId: string;
  deviceName: string;
  ownerPublicKey: string;
  /** 中转设备凭证(`Authorization: CindyRelay`)。 */
  credential: string;
  /** 本浏览器签名私钥种子(base64url)。 */
  seed: string;
}

export const PROFILE_STORAGE_KEY = 'cindy.web.relay.v1';
const SEED_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function parseProfile(raw: string | null): WebRelayProfile | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<WebRelayProfile>;
    const baseUrl = typeof value.baseUrl === 'string' ? normalizeRelayBaseUrl(value.baseUrl) : null;
    if (
      value.version !== 1 || !baseUrl ||
      typeof value.relayId !== 'string' || typeof value.name !== 'string' ||
      typeof value.deviceId !== 'string' || typeof value.deviceName !== 'string' ||
      !isRelayPublicKey(value.ownerPublicKey) ||
      typeof value.credential !== 'string' || !value.credential ||
      typeof value.seed !== 'string' || !SEED_PATTERN.test(value.seed)
    ) {
      return null;
    }
    return {
      version: 1, relayId: value.relayId, name: value.name, baseUrl, deviceId: value.deviceId,
      deviceName: value.deviceName, ownerPublicKey: value.ownerPublicKey, credential: value.credential, seed: value.seed,
    };
  } catch {
    return null;
  }
}

export function loadProfile(storage: Pick<Storage, 'getItem'>): WebRelayProfile | null {
  try {
    return parseProfile(storage.getItem(PROFILE_STORAGE_KEY));
  } catch {
    return null;
  }
}

/** 写入失败(隐私模式、配额)要让调用方知道:否则刷新页面后凭证就丢了,而中转上已经多了一台设备。 */
export function saveProfile(storage: Pick<Storage, 'setItem'>, profile: WebRelayProfile): void {
  storage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
}

export function clearProfile(storage: Pick<Storage, 'removeItem'>): void {
  try {
    storage.removeItem(PROFILE_STORAGE_KEY);
  } catch {
    // 删不掉时调用方仍会丢弃内存中的连接。
  }
}
