/**
 * 远程桌面(浏览器版):看到并操作被控电脑的整个屏幕。
 *
 * 与 Desktop 的查看窗口、手机共用同一批部件:`RemoteDesktopViewerSession`(租约:开始、控制、心跳、停止)、
 * `RemoteDesktopViewerMedia`(WebRTC 信令)和 `mountRemoteDesktopViewer`(浏览器里的画面、鼠标键盘、截图兜底)。
 * 这里只负责把它们接到网页的 device-link 连接上 —— 请求走 `device-link:remote-desktop:v1` 通道的 invoke,
 * 视频由浏览器与被控电脑经 WebRTC 直接传输(信令经中转),不经过中转转发画面。
 *
 * 只实现查看与操作所需的部分:显示器选择、画质/帧率/声音、适应窗口/实际大小、退出时与空闲时锁屏、网络状态。
 * 剪贴板同步、分辨率切换、隐私屏幕、代输入窗口视图等暂不提供(见方案 §17.1)。
 */
import {
  DESKTOP_KEY_CODES,
  isDesktopInput,
  REMOTE_DESKTOP_CHANNEL,
  REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_MAX_FRAME_BYTES,
  REMOTE_DESKTOP_NETWORK,
  remoteDesktopFailureKey,
  RemoteDesktopViewerMedia,
  RemoteDesktopViewerSession,
  resolveDesktopIceServers,
  type RemoteDesktopCapabilities,
  type RemoteDesktopRequest,
  type RemoteDesktopVideoSettings,
} from '@cindy/device-link';
import { mountRemoteDesktopViewer } from '@cindy/maker-shared/remote-desktop-viewer';

import type { RemoteApi } from './remote';

export type DesktopStatus = 'connecting' | 'reconnecting' | 'live' | 'compatibility';
export type IdleMinutes = 0 | 1 | 5 | 10 | 15 | 30;

export interface DesktopPreferences {
  lockOnExit: boolean;
  idleTimeoutMinutes: IdleMinutes;
  audio: boolean;
}

export const DEFAULT_DESKTOP_PREFERENCES: DesktopPreferences = { lockOnExit: true, idleTimeoutMinutes: 5, audio: false };

export interface DesktopSnapshot {
  status: DesktopStatus;
  /** `remoteDesktopFailureKey` 的结果或 'controlUnavailable' / 'failed';null = 没有错误。 */
  error: string | null;
  caps: RemoteDesktopCapabilities | null;
  displayId: string;
  controlling: boolean;
  ready: boolean;
  transport: '' | 'video' | 'direct' | 'relay' | 'screenshots';
  latency: number | null;
  settings: RemoteDesktopVideoSettings;
  preferences: DesktopPreferences;
  scaleMode: 'fit' | 'actual' | 'custom';
}

const CONNECTION_BUDGET_MS = REMOTE_DESKTOP_CONNECTION_TIMEOUT_MS;
const HEARTBEAT_MS = 3000;
const FRAME_POLL_MS = 350;

export class WebDesktopController {
  private state: DesktopSnapshot;
  private session: RemoteDesktopViewerSession;
  private media: RemoteDesktopViewerMedia;
  private runtime: ReturnType<typeof mountRemoteDesktopViewer>;
  private timers: ReturnType<typeof setInterval>[];
  private epoch = 0;
  private disposed = false;
  private opening = false;
  private streaming = false;
  private resuming = false;
  private retryAt = 0;
  private retryDelay = 1000;
  private heartbeatBusy: string | null = null;
  private frameBusy: string | null = null;
  private connectionTimer: ReturnType<typeof setTimeout> | null = null;
  private offers = 0;
  private pendingSettings = false;
  private mediaChanging = false;

  constructor(
    private readonly api: RemoteApi,
    private readonly deviceId: string,
    root: HTMLElement,
    preferences: DesktopPreferences,
    private readonly changed: (state: DesktopSnapshot) => void,
  ) {
    this.state = {
      status: 'connecting', error: null, caps: null, displayId: '', controlling: false, ready: false,
      transport: '', latency: null, settings: { fps: 30, quality: 'auto', audio: preferences.audio },
      preferences, scaleMode: 'fit',
    };
    this.session = new RemoteDesktopViewerSession(this.request);
    this.media = new RemoteDesktopViewerMedia({
      request: this.request,
      send: (message) => this.runtime.receive(message),
      // 自建中转没有 TURN 配置:直接退回公共 STUN(不发必然 404 的请求)。
      loadIce: () => resolveDesktopIceServers(() => Promise.reject(new Error('NO_ICE_CONFIG'))),
      current: () => this.session.lease && this.state.caps
        ? {
            lease: this.session.lease,
            caps: this.state.caps,
            settings: { ...this.state.settings, audio: this.state.settings.audio && this.state.caps.systemAudio === true },
          }
        : null,
      onOfferStart: () => { this.offers++; },
      onOfferSettled: () => { this.offers = Math.max(0, this.offers - 1); this.applySettings(); },
    });
    this.runtime = mountRemoteDesktopViewer(root, (message) => this.message(message), {
      desktop: true,
      net: REMOTE_DESKTOP_NETWORK,
      iceServers: REMOTE_DESKTOP_ICE_SERVERS,
      keyCodes: DESKTOP_KEY_CODES,
    });
    this.timers = [setInterval(() => void this.heartbeat(), HEARTBEAT_MS), setInterval(() => void this.frame(), FRAME_POLL_MS)];
    void this.connect();
  }

  get snapshot(): DesktopSnapshot { return this.state; }

  private publish(patch: Partial<DesktopSnapshot>): void {
    this.state = { ...this.state, ...patch };
    const waiting = !this.disposed && !this.state.error && (!this.state.ready || this.state.status === 'reconnecting');
    if (!waiting) {
      if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
      this.connectionTimer = null;
    } else if (this.connectionTimer === null) {
      // 短暂失败与媒体回退不重置总预算。
      this.connectionTimer = setTimeout(() => this.fail(new Error('DESKTOP_CONNECTION_TIMEOUT')), CONNECTION_BUDGET_MS);
    }
    if (!this.disposed) this.changed(this.state);
  }

  /** 所有请求走中转;开始与心跳带上退出锁屏与空闲锁屏的策略(与手机一致)。 */
  private request = async <T>(request: RemoteDesktopRequest, beforeSend?: () => void): Promise<T> => {
    beforeSend?.();
    if (this.disposed) throw new Error('DESKTOP_STOPPED');
    let message = request;
    if (message.op === 'start' || message.op === 'heartbeat') {
      message = {
        ...message,
        lockOnExit: this.state.preferences.lockOnExit,
        ...(this.state.caps?.idleLock ? { idleTimeoutMinutes: this.state.preferences.idleTimeoutMinutes } : {}),
      };
    }
    try {
      return await this.api.invoke<T>(this.deviceId, REMOTE_DESKTOP_CHANNEL, [message]);
    } catch (error) {
      throw new Error(error instanceof Error ? error.message : 'DESKTOP_UNAVAILABLE');
    }
  };

  private async connect(takeover = false): Promise<void> {
    if (this.opening || this.disposed) return;
    this.opening = true;
    const epoch = this.epoch;
    this.publish({ error: null, status: this.resuming ? 'reconnecting' : 'connecting', ready: false });
    try {
      const { caps, lease } = await this.session.connect({
        displayId: this.state.displayId || undefined,
        resume: this.resuming,
        takeover,
        // 网页总是用来操作的:支持 autoControl 的电脑在开始时直接交出控制。
        control: true,
        isCurrent: () => this.epoch === epoch && !this.disposed,
        onCapabilities: (value) => this.publish({ caps: value }),
        onStart: () => { this.resuming = true; },
      });
      if (epoch !== this.epoch) return;
      this.publish({ caps, displayId: lease.display.id, status: 'connecting' });
      this.runtime.receive({
        type: 'init',
        epoch: lease.lease,
        width: lease.display.width,
        height: lease.display.height,
        fillHeight: false,
        trickleIce: caps.trickleIce === true,
        audio: caps.systemAudio === true && this.state.settings.audio,
        macKeyboard: /Mac/.test(navigator.platform),
        // 只有被控电脑自己的复制/粘贴修饰键才是剪贴板快捷键。
        clipboardModifier: caps.platform === 'darwin' ? 'meta' : 'control',
      });
      this.runtime.receive({ type: 'mode', mode: 'pointer' });
      if (!caps.canControl) throw new Error('DESKTOP_INPUT_UNSUPPORTED');
      if (lease.controlling) {
        this.syncControl();
        this.applySettings();
      } else {
        const result = await this.session.control(true);
        if (epoch !== this.epoch) return;
        if (!result.controlling) throw new Error('DESKTOP_VIEW_ONLY');
        this.syncControl();
        this.applySettings();
      }
    } catch (error) {
      if (epoch === this.epoch) this.fail(error);
    } finally {
      if (epoch === this.epoch) this.opening = false;
    }
  }

  private cancel(preserveFrame = false, preserveLease = false): void {
    this.epoch++;
    this.offers = 0;
    this.pendingSettings = false;
    this.mediaChanging = false;
    this.streaming = false;
    this.opening = false;
    this.media.reset();
    this.runtime?.receive({ type: 'releaseInput' });
    void this.session.stop(false, preserveLease).catch(() => undefined);
    this.runtime?.receive({ type: 'stop', preserveFrame });
    this.publish({ controlling: false, ready: false, transport: '', latency: null });
  }

  private fail(error: unknown): void {
    const code = error instanceof Error ? error.message : '';
    const blocked = remoteDesktopFailureKey(code)
      ?? (/DESKTOP_(VIEW_ONLY|INPUT_(BUSY|UNSUPPORTED|UNAVAILABLE|TIMEOUT))/.test(code) ? 'controlUnavailable' : null);
    this.cancel(true, !blocked && this.state.caps?.idleLock === true && this.state.caps.automaticReconnect === true
      && this.state.preferences.idleTimeoutMinutes > 0);
    this.publish({ status: 'reconnecting', error: blocked });
    this.retryAt = Date.now() + this.retryDelay;
    this.retryDelay = Math.min(15_000, this.retryDelay * 2);
  }

  /** 用户点「重试」:放弃当前状态重新开始(连接被占用时请求接管)。 */
  retry(): void {
    const takeover = this.state.error === 'connectionBusy';
    this.cancel(true);
    this.resuming = false;
    void this.connect(takeover);
  }

  private syncControl(): void {
    const controlling = this.state.ready && this.session.lease?.controlling === true;
    if (controlling === this.state.controlling) return;
    this.publish({ controlling });
    this.runtime.receive({ type: 'control', enabled: controlling });
  }

  private present(status: DesktopStatus): void {
    if (status === 'live') this.mediaChanging = false;
    this.retryDelay = 1000;
    this.publish({ ready: true, status });
    this.syncControl();
    this.applySettings();
  }

  selectDisplay(displayId: string): void {
    if (!this.state.caps?.displays.some((d) => d.id === displayId) || displayId === this.state.displayId) return;
    this.cancel(true);
    this.resuming = false;
    this.publish({ displayId });
    void this.connect();
  }

  settings(patch: Partial<RemoteDesktopVideoSettings>): void {
    this.publish({ settings: { ...this.state.settings, ...patch } });
    this.pendingSettings = true;
    setTimeout(() => this.applySettings(), 0);
  }

  preferences(patch: Partial<DesktopPreferences>): void {
    this.publish({ preferences: { ...this.state.preferences, ...patch } });
    if (patch.audio !== undefined) this.settings({ audio: patch.audio });
  }

  private applySettings(): void {
    if (!this.pendingSettings || !this.session.lease || !this.state.ready || this.offers || this.mediaChanging
      || !['live', 'compatibility'].includes(this.state.status)) return;
    this.pendingSettings = false;
    this.mediaChanging = true;
    this.runtime.receive({ type: 'videoSettings', audio: this.state.settings.audio && this.state.caps?.systemAudio === true });
  }

  fit(): void { this.runtime.receive({ type: 'fit' }); }
  actualSize(): void { this.runtime.receive({ type: 'actualSize' }); }
  releaseInput(): void { this.runtime.receive({ type: 'releaseInput' }); }

  /** 主动结束:释放租约;被控电脑按「退出时锁屏」策略处理。 */
  async close(): Promise<void> {
    this.runtime.receive({ type: 'releaseInput' });
    this.timers.forEach(clearInterval);
    this.timers = [];
    await this.session.stop(this.state.preferences.lockOnExit && this.state.caps?.lockOnExit === true).catch(() => undefined);
    this.dispose();
  }

  private async heartbeat(): Promise<void> {
    if (this.disposed) return;
    if (!this.session.lease) {
      if (!this.state.error && Date.now() >= this.retryAt) void this.connect();
      return;
    }
    const leaseId = this.session.lease.lease;
    if (this.heartbeatBusy === leaseId) return;
    this.heartbeatBusy = leaseId;
    const epoch = this.epoch;
    try {
      const result = await this.session.heartbeat();
      if (epoch === this.epoch) {
        if (!result.controlling && !this.opening) this.fail(new Error('DESKTOP_VIEW_ONLY'));
        else this.syncControl();
      }
    } catch (error) {
      if (epoch === this.epoch && !(error instanceof Error && error.message === 'INVOKE_TIMEOUT')) this.fail(error);
    } finally {
      if (this.heartbeatBusy === leaseId) this.heartbeatBusy = null;
    }
  }

  /** 视频建立前(或回退时)用截图保证看得到画面。 */
  private async frame(): Promise<void> {
    const lease = this.session.lease;
    if (!lease || this.streaming || this.frameBusy === lease.lease || this.disposed) return;
    this.frameBusy = lease.lease;
    try {
      const result = await this.request<{ jpeg: string | null; cursor?: unknown }>({
        op: 'frame', lease: lease.lease, cursorOverlay: this.state.caps?.cursorOverlay === true,
      });
      if (this.session.lease === lease && !this.streaming && typeof result.jpeg === 'string'
        && result.jpeg.length <= Math.ceil(REMOTE_DESKTOP_MAX_FRAME_BYTES / 3) * 4) {
        this.runtime.receive({ type: 'frame', jpeg: result.jpeg, ...('cursor' in result ? { cursor: result.cursor } : {}) });
      }
    } catch (error) {
      if (this.session.lease === lease) this.fail(error);
    } finally {
      if (this.frameBusy === lease.lease) this.frameBusy = null;
    }
  }

  /** 画面运行时发来的消息:信令交给 media,输入转给被控电脑,状态更新界面。 */
  private message(message: Record<string, unknown>): void {
    const lease = this.session.lease;
    if (!lease || message.epoch !== lease.lease || this.disposed) return;
    if (['iceConfig', 'offer', 'ice'].includes(String(message.type))) {
      void this.media.handle(message).catch((error) => {
        if (this.session.lease === lease) this.fail(error);
      });
      return;
    }
    switch (message.type) {
      case 'scaleMode':
        if (message.mode === 'fit' || message.mode === 'actual' || message.mode === 'custom') this.publish({ scaleMode: message.mode });
        break;
      case 'streaming':
        this.streaming = true;
        this.publish({ transport: 'video', latency: null });
        this.present('live');
        break;
      case 'framePresented':
        if (this.streaming) break;
        this.publish({ transport: 'screenshots', latency: null });
        this.present('compatibility');
        break;
      case 'fallback':
        this.mediaChanging = false;
        this.streaming = false;
        this.publish({ transport: 'screenshots', status: 'compatibility', latency: null });
        this.applySettings();
        break;
      case 'reconnecting':
        this.publish({ status: 'reconnecting' });
        break;
      case 'network': {
        const transport = message.transport;
        if (!this.streaming || (transport !== 'video' && transport !== 'direct' && transport !== 'relay')) break;
        const latency = message.latencyMs;
        this.publish({ transport, latency: typeof latency === 'number' && Number.isFinite(latency) && latency >= 0 ? latency : null });
        break;
      }
      case 'inputOverflow':
        this.fail(new Error('DESKTOP_INPUT_UNAVAILABLE'));
        break;
      case 'input':
        if (!Number.isSafeInteger(message.sequence) || !Array.isArray(message.events) || message.events.length > 64
          || !message.events.every(isDesktopInput)) return;
        void this.request({ op: 'input', lease: lease.lease, sequence: message.sequence as number, events: message.events })
          .catch((error) => {
            if (this.session.lease === lease && !(error instanceof Error && error.message === 'INVOKE_TIMEOUT')) this.fail(error);
          })
          .finally(() => {
            if (this.session.lease === lease) this.runtime.receive({ type: 'ack', epoch: lease.lease, sequence: message.sequence });
          });
        break;
      default:
        // 剪贴板意图、跨通道请求等暂不支持:忽略,画面运行时按未启用处理。
        break;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.cancel();
    this.disposed = true;
    if (this.connectionTimer !== null) clearTimeout(this.connectionTimer);
    this.connectionTimer = null;
    this.timers.forEach(clearInterval);
    this.runtime.dispose();
  }
}
