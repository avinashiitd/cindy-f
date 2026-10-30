/**
 * 设备互联在两种会话下可用:
 * - 已登录 Cindy 账号(cloud):官方中转或自建中转,行为不变;
 * - 未登录的本机模式(local):只能走自建中转(这台电脑开启的中转,或加入的别人的中转),从不连官方中转、
 *   不发送账号 token。中转的主人账号 ID 用 `local:<设备 ID>`,表示这个中转不属于任何账号。
 * 共享任务、供应商分享等跨账号能力仍要求登录,不在这里放开。
 */
import { RELAY_ACCOUNTLESS_OWNER_PREFIX } from '@cindy/device-link';

import * as authManager from '../authManager.js';
import { getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';

/** 已提交的本机模式会话(账号作用域切换进行中不算)。 */
export function isLocalRelaySession(): boolean {
  return !isAppSessionBoundaryPending() && getActiveAppSession().mode === 'local';
}

/** 自建中转可用:已登录,或处于本机模式。 */
export function relaySessionReady(): boolean {
  return authManager.getAuthState().isAuthenticated || isLocalRelaySession();
}

/** 开启中转时写进中转的主人账号 ID;都不满足时为 null。 */
export function relayOwnerAccountId(): string | null {
  if (authManager.getAuthState().isAuthenticated) return authManager.getCurrentUserId();
  return isLocalRelaySession() ? `${RELAY_ACCOUNTLESS_OWNER_PREFIX}${authManager.getDeviceId()}` : null;
}

/** 加入别人的中转时上报的账号 ID:本机模式下不上报(只有不属于账号的中转会接受)。 */
export function relayJoinAccountId(): string | null {
  return authManager.getAuthState().isAuthenticated ? authManager.getCurrentUserId() : null;
}
