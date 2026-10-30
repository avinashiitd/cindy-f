/**
 * 中转凭证与一次性秘密。
 *
 * - 设备凭证只用于连接这一个自建中转,与 Cindy 账号 token 无关;中转只保存 SHA-256。
 * - 主人电脑在本机生成自己的凭证,交给中转的只有哈希(Cindy 内运行与 SSH 部署两种方式一致)。
 * - 握手与 REST 都用 `Authorization: CindyRelay <凭证>`;不接受 `Bearer`,避免客户端误把账号
 *   token 发过来时被当成可用凭证继续流转。
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const RELAY_AUTH_SCHEME = 'CindyRelay';

/** 32 字节随机数,base64url。设备凭证、加入码、轮询口令、签名密钥共用同一生成方式。 */
export function createSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** 供主人电脑 / 测试生成一份设备凭证:明文只留在调用方,哈希交给中转。 */
export function createDeviceCredential(): { credential: string; credentialHash: string } {
  const credential = createSecret();
  return { credential, credentialHash: hashSecret(credential) };
}

/** 解析 `Authorization: CindyRelay <凭证>`;其它方案或格式一律视为未认证。 */
export function parseRelayAuthorization(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const match = /^CindyRelay ([A-Za-z0-9_-]{16,256})$/.exec(header.trim());
  return match ? match[1] : null;
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function hmacHex(key: string, message: string): string {
  return createHmac('sha256', key).update(message, 'utf8').digest('hex');
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]*$/.test(a) || !/^[0-9a-f]*$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** 4 位核对码:只供主人与申请设备肉眼核对,不参与鉴权。 */
export function createVerifyCode(): string {
  return String(randomBytes(2).readUInt16BE(0) % 10_000).padStart(4, '0');
}

/** 浏览器的 WebSocket 无法设置 Authorization 头,凭证改放在 `Sec-WebSocket-Protocol` 里。 */
export const RELAY_WS_SUBPROTOCOL = 'cindy-relay.v1';
const RELAY_WS_CREDENTIAL_PREFIX = 'cindy-credential.';

/**
 * 解析浏览器握手的子协议:`cindy-relay.v1, cindy-credential.<凭证>`。
 * 必须同时带版本标记和凭证才算认证;只在 WebSocket 升级里使用,REST 仍然只认 Authorization 头。
 */
export function parseRelayWebSocketProtocols(header: string | string[] | undefined): string | null {
  const raw = Array.isArray(header) ? header.join(',') : header;
  if (typeof raw !== 'string') return null;
  const offered = raw.split(',').map((item) => item.trim()).filter(Boolean);
  if (!offered.includes(RELAY_WS_SUBPROTOCOL)) return null;
  const entry = offered.find((item) => item.startsWith(RELAY_WS_CREDENTIAL_PREFIX));
  const credential = entry?.slice(RELAY_WS_CREDENTIAL_PREFIX.length);
  return credential && /^[A-Za-z0-9_-]{16,256}$/.test(credential) ? credential : null;
}
