/**
 * 浏览器里的 `RelayAuthCrypto`:纯 JS 的 @noble 做 Ed25519 / SHA-256 / HMAC(与手机同一套实现,
 * 和电脑端 node:crypto 逐字节兼容),随机数取 `crypto.getRandomValues`。
 *
 * 不用 `crypto.subtle`:它只在安全上下文(https / localhost)可用,而局域网里 http 打开中转页面也要能工作。
 */
import { ed25519 } from '@noble/curves/ed25519';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import type { RelayAuthCrypto } from '@cindy/device-link';

const encoder = new TextEncoder();

export const webRelayAuthCrypto: RelayAuthCrypto = {
  sha256: (data) => sha256(data),
  hmacSha256: (key, data) => hmac(sha256, key, data),
  ed25519PublicKey: (seed) => ed25519.getPublicKey(seed),
  ed25519Sign: (seed, message) => ed25519.sign(message, seed),
  ed25519Verify(publicKey, message, signature) {
    if (publicKey.length !== 32 || signature.length !== 64) return false;
    try {
      // 严格按 RFC 8032 核对(与 node:crypto 一致),不接受 ZIP-215 放宽的写法。
      return ed25519.verify(signature, message, publicKey, { zip215: false });
    } catch {
      return false;
    }
  },
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  utf8: (text) => encoder.encode(text),
};

/** 本浏览器的设备 ID:`web-` + 128 位随机数(满足中转的设备 ID 格式)。 */
export function createWebDeviceId(random: (size: number) => Uint8Array = webRelayAuthCrypto.randomBytes): string {
  return `web-${Array.from(random(16), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
