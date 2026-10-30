/**
 * 网页版界面:加入 → 电脑列表 → 任务列表 → 任务(消息、发送、停止、审批)。
 * 状态都在被控电脑上,网页只是控制端镜像(与手机相同的原则):每次操作后重新读取,不在本地合成状态。
 */
import { RelayJoinError, type DeviceView, type PresenceSnapshot } from '@cindy/device-link';

import { createWebConnection, type WebConnection } from './connection';
import { webRelayAuthCrypto } from './crypto';
import { h, replaceChildren } from './dom';
import { pickStrings, type Strings } from './i18n';
import { joinRelay, parseJoinInput } from './join';
import { toDisplayMessages, type RemoteMessageRow } from './messages';
import { clearProfile, loadProfile, saveProfile, type WebRelayProfile } from './profile';
import { RemoteApi, RemoteError, type PendingInteraction, type RemoteSessionRow } from './remote';
import { DEFAULT_DESKTOP_PREFERENCES, WebDesktopController, type DesktopPreferences, type DesktopSnapshot } from './desktop';

const REFRESH_DEBOUNCE_MS = 300;

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  return `${browser} (web)`;
}

function formatTime(iso: string | null | undefined): string {
  const time = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(time) ? new Date(time).toLocaleString() : '';
}

function newClientId(): string {
  const bytes = webRelayAuthCrypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function joinErrorText(t: Strings, error: unknown): string {
  if (error instanceof RelayJoinError) {
    switch (error.code) {
      case 'UNREACHABLE': return t.joinUnreachable;
      case 'NOT_A_RELAY':
      case 'INCOMPATIBLE': return t.joinNotRelay;
      case 'REJECTED': return t.joinRejected;
      case 'EXPIRED': return t.joinExpired;
      case 'CODE_INVALID': return t.joinCodeInvalid;
      case 'OWNER_MISMATCH': return t.joinOwnerMismatch;
      case 'CANCELLED': return '';
      default: return t.joinFailed;
    }
  }
  return t.joinFailed;
}

export function mountApp(root: HTMLElement): void {
  const t = pickStrings(navigator.language);
  document.title = t.title;
  const storage = safeStorage();
  let connection: WebConnection | null = null;
  let api: RemoteApi | null = null;
  let devices = new Map<string, DeviceView>();
  let status: 'connecting' | 'online' | 'stopped' = 'connecting';
  let teardownView: (() => void) | null = null;
  let renderCurrent: () => void = () => undefined;
  let offs: Array<() => void> = [];

  const shell = h('div', { class: 'shell' });
  replaceChildren(root, shell);

  function setView(render: () => void, teardown?: () => void): void {
    teardownView?.();
    teardownView = teardown ?? null;
    renderCurrent = render;
    render();
  }

  function header(extra?: Node): HTMLElement {
    return h('header', { class: 'bar' },
      h('div', { class: 'bar-title' },
        h('strong', {}, connection?.profile.name ?? t.title),
        connection ? h('span', { class: `pill status-${status}` }, t.status[status]) : null),
      extra ?? null,
      connection ? h('button', { class: 'btn ghost', onclick: leaveRelay }, t.leave) : null);
  }

  // ── 加入 ────────────────────────────────────────────────────────────────
  function showJoin(): void {
    stopConnection();
    const hash = location.hash.includes('#/join?') ? location.href.slice(location.href.indexOf('#/join?')) : '';
    const linkInput = h('textarea', { id: 'join-link', rows: 3, spellcheck: false, autocomplete: 'off' });
    linkInput.value = hash;
    const nameInput = h('input', { id: 'join-name', type: 'text', maxlength: 64 });
    nameInput.value = defaultDeviceName();
    const message = h('p', { class: 'note', role: 'status' });
    const submit = h('button', { class: 'btn primary', type: 'button' }, t.joinButton);
    let abort: AbortController | null = null;

    submit.addEventListener('click', async () => {
      const link = parseJoinInput(linkInput.value);
      if (!link) { message.textContent = t.joinInvalid; message.className = 'note error'; return; }
      abort = new AbortController();
      submit.disabled = true;
      linkInput.disabled = true;
      message.className = 'note';
      message.textContent = '';
      const cancel = h('button', { class: 'btn ghost', type: 'button', onclick: () => abort?.abort() }, t.joinCancel);
      try {
        const profile = await joinRelay({
          link,
          deviceName: nameInput.value.trim() || defaultDeviceName(),
          fetchFn: (url, init) => fetch(url, init),
          crypto: webRelayAuthCrypto,
          signal: abort.signal,
          onVerifyCode: (code) => replaceChildren(message, `${t.joinWaiting} `, h('strong', { class: 'code' }, code), ' ', cancel),
        });
        // 加入链接里的一次性秘密不留在地址栏和历史记录里。
        history.replaceState(null, '', location.pathname);
        let saved = true;
        try { if (storage) saveProfile(storage, profile); else saved = false; } catch { saved = false; }
        startSession(profile);
        if (!saved) notice(t.joinSaveFailed);
      } catch (error) {
        const text = joinErrorText(t, error);
        message.className = 'note error';
        message.textContent = text;
        submit.disabled = false;
        linkInput.disabled = false;
      }
    });

    setView(() => replaceChildren(shell,
      h('main', { class: 'panel narrow' },
        h('h1', {}, t.joinTitle),
        h('p', { class: 'note' }, t.joinHint),
        h('label', { for: 'join-link' }, t.joinLinkLabel), linkInput,
        h('label', { for: 'join-name' }, t.joinNameLabel), nameInput,
        h('div', { class: 'row' }, submit),
        message)));
  }

  function notice(text: string): void {
    shell.prepend(h('div', { class: 'toast', role: 'status' }, text));
    setTimeout(() => shell.querySelector('.toast')?.remove(), 8000);
  }

  // ── 连接 ────────────────────────────────────────────────────────────────
  function stopConnection(): void {
    for (const off of offs) off();
    offs = [];
    connection?.stop();
    connection = null;
    api = null;
    devices = new Map();
  }

  function startSession(profile: WebRelayProfile): void {
    stopConnection();
    connection = createWebConnection(profile);
    const client = connection.client;
    status = 'connecting';
    api = new RemoteApi(client, profile.baseUrl, profile.credential, profile.deviceName);
    offs.push(client.onStatusChange((next) => {
      status = next;
      if (next !== 'online') api?.resetLinks();
      renderCurrent();
      if (next === 'online') void refreshDevices();
    }));
    offs.push(client.onPresenceChanged((snap: PresenceSnapshot) => {
      const existing = devices.get(snap.deviceId);
      devices.set(snap.deviceId, {
        deviceId: snap.deviceId,
        name: snap.selfName || snap.deviceName,
        selfName: snap.selfName,
        deviceInfo: snap.deviceInfo,
        platform: snap.platform,
        appVersion: snap.appVersion,
        lastSeenAt: new Date(snap.lastSeenAt).toISOString(),
        online: snap.online,
        busy: snap.busy,
        remoteControlEnabled: snap.remoteControlEnabled,
        isSelf: snap.deviceId === profile.deviceId,
        ...(existing && !snap.deviceName ? { name: existing.name } : {}),
      });
      renderCurrent();
    }));
    showDevices();
    void refreshDevices();
  }

  async function refreshDevices(): Promise<void> {
    if (!api) return;
    try {
      const list = await api.listDevices();
      devices = new Map(list.map((device) => [device.deviceId, device]));
      renderCurrent();
    } catch (error) {
      if (error instanceof RemoteError && error.code === 'UNAUTHORIZED') {
        // 凭证被主人撤销:清掉本机记录,回到加入页。
        if (storage) clearProfile(storage);
        showJoin();
      }
    }
  }

  function leaveRelay(): void {
    if (!window.confirm(t.leaveConfirm)) return;
    const profile = connection?.profile;
    if (profile) {
      // 尽力让中转删掉这台浏览器;失败时主人仍可在电脑上移除。
      void fetch(`${profile.baseUrl}/api/device-link/devices/${encodeURIComponent(profile.deviceId)}`, {
        method: 'DELETE',
        headers: { Authorization: `CindyRelay ${profile.credential}` },
      }).catch(() => undefined);
    }
    if (storage) clearProfile(storage);
    showJoin();
  }

  // ── 工作区:左侧电脑列表,右侧任务或远程桌面(桌面浏览器的宽屏布局)─────────────
  type Mode = 'tasks' | 'desktop';
  let selected: { deviceId: string; mode: Mode } | null = null;
  let pane: { dispose(): void } | null = null;

  function showDevices(): void {
    selected = null;
    showWorkspace();
  }

  function showWorkspace(): void {
    const sidebar = h('nav', { class: 'sidebar', 'aria-label': t.devices });
    const main = h('main', { class: 'main' });

    const paintSidebar = () => {
      const others = [...devices.values()].filter((device) => !device.isSelf)
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      replaceChildren(sidebar,
        h('h2', { class: 'side-title' }, t.devices),
        others.length === 0 ? h('p', { class: 'note' }, t.noDevices) : null,
        ...others.map((device) => {
          const usable = device.online && device.remoteControlEnabled;
          const active = selected?.deviceId === device.deviceId;
          return h('div', { class: `computer${active ? ' active' : ''}` },
            h('button', { class: 'computer-name', disabled: !usable, onclick: () => openDevice(device.deviceId, 'tasks') },
              h('span', { class: `dot ${device.online ? 'on' : 'off'}`, 'aria-hidden': 'true' }),
              h('span', { class: 'item-main' }, h('strong', {}, device.name),
                h('span', { class: 'sub' }, device.online ? (device.remoteControlEnabled ? [device.platform, device.appVersion].filter(Boolean).join(' · ') : t.controlOff) : t.offline))),
            active ? h('div', { class: 'tabs', role: 'tablist' },
              h('button', { class: `tab${selected?.mode === 'tasks' ? ' on' : ''}`, role: 'tab', onclick: () => openDevice(device.deviceId, 'tasks') }, t.tabTasks),
              h('button', { class: `tab${selected?.mode === 'desktop' ? ' on' : ''}`, role: 'tab', onclick: () => openDevice(device.deviceId, 'desktop') }, t.tabDesktop)) : null);
        }));
    };

    const openDevice = (deviceId: string, mode: Mode) => {
      const device = devices.get(deviceId);
      if (!device || !api) return;
      if (selected?.deviceId === deviceId && selected.mode === mode && pane) return;
      pane?.dispose();
      pane = null;
      selected = { deviceId, mode };
      paintSidebar();
      pane = mode === 'tasks'
        ? mountTasks(main, device)
        : mountDesktop(main, device);
    };

    teardownWorkspace?.();
    teardownWorkspace = () => { pane?.dispose(); pane = null; };
    setView(() => {
      if (!shell.querySelector('.workspace')) {
        replaceChildren(shell, header(), h('div', { class: 'workspace' }, sidebar, main));
        if (!selected) replaceChildren(main, h('p', { class: 'note empty' }, t.selectComputer));
      } else {
        shell.querySelector('.bar')?.replaceWith(header());
      }
      paintSidebar();
    }, () => { teardownWorkspace?.(); teardownWorkspace = null; });
  }
  let teardownWorkspace: (() => void) | null = null;

  // ── 任务:左边任务列表,右边所选任务的对话 ─────────────────────────────────────
  function mountTasks(container: HTMLElement, device: DeviceView): { dispose(): void } {
    let sessions: RemoteSessionRow[] = [];
    let failed = false;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let chat: { dispose(): void } | null = null;
    let activeId: string | null = null;

    const listEl = h('div', { class: 'task-list' });
    const chatEl = h('div', { class: 'task-chat' }, h('p', { class: 'note empty' }, t.selectTask));
    replaceChildren(container, h('div', { class: 'split' }, listEl, chatEl));

    const paintList = () => replaceChildren(listEl,
      h('div', { class: 'row between' }, h('h2', { class: 'side-title' }, t.tasks),
        h('button', { class: 'btn ghost', onclick: () => void load() }, t.refresh)),
      failed ? h('p', { class: 'note error' }, t.loadFailed) : null,
      !failed && sessions.length === 0 ? h('p', { class: 'note' }, t.noTasks) : null,
      h('ul', { class: 'list' }, ...sessions.map((session) => h('li', {},
        h('button', { class: `item${session.id === activeId ? ' active' : ''}`, onclick: () => openChat(session) },
          h('span', { class: 'item-main' }, h('strong', {}, session.title || session.id),
            session.preview ? h('span', { class: 'sub clamp' }, session.preview) : null,
            h('span', { class: 'sub' }, formatTime(session.lastActivityAt ?? session.updatedAt))))))));

    const load = async () => {
      if (!api) return;
      try { sessions = await api.listSessions(device.deviceId); failed = false; } catch { failed = true; }
      if (alive) paintList();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS); };

    const openChat = (session: RemoteSessionRow) => {
      chat?.dispose();
      activeId = session.id;
      paintList();
      chat = mountChat(chatEl, device, session);
    };

    const off = api?.onPush((event) => {
      if (event.from === device.deviceId && event.channel.startsWith('local-db:sessions:')) schedule();
    });
    void api?.subscribe(device.deviceId, ['sessions']).catch(() => undefined);
    void load();
    return {
      dispose() {
        alive = false; clearTimeout(timer); off?.(); chat?.dispose();
        void api?.unsubscribe(device.deviceId, ['sessions']).catch(() => undefined);
      },
    };
  }

  function mountChat(container: HTMLElement, device: DeviceView, initial: RemoteSessionRow): { dispose(): void } {
    let session = initial;
    let rows: RemoteMessageRow[] = [];
    let interactions: PendingInteraction[] = [];
    let running = false;
    let error = '';
    let sending = false;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const topic = `session:${session.id}`;

    const input = h('textarea', { class: 'composer', rows: 2, placeholder: t.placeholder });
    const log = h('div', { class: 'log', role: 'log' });
    const side = h('div', { class: 'side' });
    const runBadge = h('span', { class: 'pill ok' }, t.running);
    const stopButton = h('button', { class: 'btn', onclick: () => api && void api.stop(device.deviceId, session.id).then(load, load) }, t.stop);
    const titleEl = h('h1', {}, session.title || session.id);

    const load = async () => {
      if (!api) return;
      try {
        const [fresh, messages, pending, active] = await Promise.all([
          api.getSession(device.deviceId, session.id).catch(() => session),
          api.listMessages(device.deviceId, session.id),
          api.listPendingInteractions(device.deviceId, session.id).catch(() => [] as PendingInteraction[]),
          api.invoke<Array<{ sessionId: string; isTurnRunning?: boolean }>>(device.deviceId, 'maker:list-active').catch(() => []),
        ]);
        session = fresh; rows = messages; interactions = pending;
        running = active.some((item) => item.sessionId === session.id && item.isTurnRunning);
        error = '';
      } catch { error = t.loadFailed; }
      if (alive) paint();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS); };

    const respond = async (request: PendingInteraction['request'], behavior: 'allow' | 'deny') => {
      if (!api || typeof request.requestId !== 'string') return;
      try { await api.resolvePermission(device.deviceId, request.requestId, behavior); } catch (e) { error = t.sendFailed + (e instanceof Error ? e.message : ''); }
      await load();
    };
    const send = async () => {
      const text = input.value.trim();
      if (!text || sending || !api) return;
      sending = true;
      try { await api.sendText(device.deviceId, session, text, newClientId()); input.value = ''; error = ''; }
      catch (e) { error = t.sendFailed + (e instanceof Error ? e.message : ''); }
      sending = false;
      await load();
    };
    const paint = () => {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      titleEl.textContent = session.title || session.id;
      replaceChildren(log, ...toDisplayMessages(rows).map((message) =>
        h('div', { class: `msg ${message.kind}` },
          message.kind === 'tool' ? h('span', { class: 'pill muted' }, `${t.tool}: ${message.text}`) : h('div', { class: 'bubble' }, message.text))));
      if (stick) log.scrollTop = log.scrollHeight;
      replaceChildren(side,
        ...interactions.map((item) => {
          const request = item.request;
          if (request.kind === 'permission') {
            const tool = typeof request.toolName === 'string' ? request.toolName : '';
            return h('div', { class: 'card' },
              h('strong', {}, `${t.permissionAsk}${tool ? `: ${tool}` : ''}`),
              typeof request.description === 'string' ? h('p', { class: 'sub' }, request.description) : null,
              h('div', { class: 'row' },
                h('button', { class: 'btn primary', onclick: () => void respond(request, 'allow') }, t.allow),
                h('button', { class: 'btn', onclick: () => void respond(request, 'deny') }, t.deny)));
          }
          return h('div', { class: 'card' }, h('p', {}, t.unsupportedInteraction));
        }),
        error ? h('p', { class: 'note error' }, error) : null);
      stopButton.hidden = !running; runBadge.hidden = !running;
    };
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
    });
    const off = api?.onPush((event) => {
      if (event.from !== device.deviceId) return;
      if (event.channel.startsWith('maker:') || event.channel.startsWith('local-db:messages:') || event.channel.startsWith('local-db:sessions:')) schedule();
    });
    replaceChildren(container, h('div', { class: 'chat' },
      h('div', { class: 'row between' }, titleEl, h('div', { class: 'row' }, runBadge, stopButton)),
      log, side,
      h('div', { class: 'row composer-row' }, input, h('button', { class: 'btn primary', onclick: () => void send() }, t.send))));
    paint();
    void (async () => {
      try { await api?.openLink(device.deviceId); await api?.subscribe(device.deviceId, [topic]); }
      catch (e) { error = e instanceof RemoteError && e.code === 'REMOTE_DISABLED' ? t.remoteOff : t.loadFailed; }
      await load();
    })();
    return {
      dispose() {
        alive = false; clearTimeout(timer); off?.();
        void api?.unsubscribe(device.deviceId, [topic]).catch(() => undefined);
      },
    };
  }

  // ── 远程桌面 ────────────────────────────────────────────────────────────
  function mountDesktop(container: HTMLElement, device: DeviceView): { dispose(): void } {
    const prefKey = `cindy.web.desktop.${device.deviceId}`;
    const loadPrefs = (): DesktopPreferences => {
      try {
        const raw = JSON.parse(storage?.getItem(prefKey) ?? 'null') as Partial<DesktopPreferences> | null;
        return {
          lockOnExit: raw?.lockOnExit !== false,
          idleTimeoutMinutes: ([0, 1, 5, 10, 15, 30] as number[]).includes(raw?.idleTimeoutMinutes as number)
            ? raw!.idleTimeoutMinutes as DesktopPreferences['idleTimeoutMinutes'] : DEFAULT_DESKTOP_PREFERENCES.idleTimeoutMinutes,
          audio: raw?.audio === true,
        };
      } catch { return { ...DEFAULT_DESKTOP_PREFERENCES }; }
    };

    const stage = h('div', { id: 'stage', tabindex: 0, 'aria-label': t.tabDesktop },
      h('div', { id: 'bg', 'aria-hidden': 'true' }, h('canvas', { id: 'bg-canvas' })),
      h('img', { id: 'image', alt: '' }),
      h('video', { id: 'video', autoplay: true, muted: true, playsinline: true }),
      h('div', { id: 'cursor' }, h('img', { id: 'cursor-image', alt: '' })));
    const overlay = h('div', { class: 'viewer-overlay', role: 'status' });
    const content = h('div', { class: 'viewer-content' }, stage,
      h('textarea', { id: 'keyboard-input', autocapitalize: 'off', autocomplete: 'off', spellcheck: false, 'aria-label': 'Keyboard' }),
      h('div', { id: 'mouse-buttons', hidden: true }, h('button', { id: 'mouse-left', type: 'button' }), h('button', { id: 'mouse-right', type: 'button' }),
        h('button', { id: 'mouse-wheel', type: 'button' }, h('span', { id: 'mouse-wheel-grip' }))),
      overlay);
    const toolbar = h('div', { class: 'viewer-toolbar' });
    replaceChildren(container, h('div', { class: 'viewer' }, toolbar, content));

    let controller: WebDesktopController | null = null;
    const select = (id: string, label: string, options: Array<[string, string]>, value: string, onChange: (v: string) => void) => {
      const el = h('select', { id, 'aria-label': label }, ...options.map(([v, text]) => h('option', { value: v }, text)));
      el.value = value;
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const paintToolbar = (state: DesktopSnapshot) => {
      const status = state.status === 'live' ? t.desktopLive : state.status === 'compatibility' ? t.desktopScreenshots
        : state.status === 'reconnecting' ? t.desktopReconnecting : t.desktopConnecting;
      const caps = state.caps;
      replaceChildren(toolbar,
        h('span', { class: `pill ${state.ready ? 'ok' : 'muted'}` }, state.ready && state.latency !== null ? `${status} · ${Math.round(state.latency)} ms` : status),
        caps && caps.displays.length > 1 ? select('dd-display', t.desktopDisplay, caps.displays.map((d) => [d.id, d.name || d.id]), state.displayId, (v) => controller?.selectDisplay(v)) : null,
        h('button', { class: 'btn ghost', onclick: () => controller?.fit(), disabled: !state.ready }, t.desktopFit),
        h('button', { class: 'btn ghost', onclick: () => controller?.actualSize(), disabled: !state.ready }, t.desktopActual),
        caps?.videoSettings ? select('dd-fps', t.desktopFps, [['30', '30 fps'], ['60', '60 fps']], String(state.settings.fps), (v) => controller?.settings({ fps: v === '60' ? 60 : 30 })) : null,
        caps?.videoSettings ? select('dd-quality', t.desktopQuality, [['auto', t.desktopQualityAuto], ['saver', t.desktopQualitySaver], ['hd', t.desktopQualityHd]],
          state.settings.quality, (v) => controller?.settings({ quality: v as 'auto' | 'saver' | 'hd' })) : null,
        caps?.systemAudio ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.preferences.audio, onchange: (e: Event) => controller?.preferences({ audio: (e.target as HTMLInputElement).checked }) }), t.desktopAudio) : null,
        caps?.lockOnExit ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.preferences.lockOnExit, onchange: (e: Event) => controller?.preferences({ lockOnExit: (e.target as HTMLInputElement).checked }) }), t.desktopLockOnExit) : null,
        caps?.idleLock ? select('dd-idle', t.desktopIdle, ([0, 1, 5, 10, 15, 30] as const).map((m) => [String(m), m === 0 ? t.desktopIdleNever : t.desktopMinutes.replace('{n}', String(m))] as [string, string]),
          String(state.preferences.idleTimeoutMinutes), (v) => controller?.preferences({ idleTimeoutMinutes: Number(v) as DesktopPreferences['idleTimeoutMinutes'] })) : null,
        h('span', { class: 'grow' }),
        h('button', { class: 'btn ghost', onclick: () => void toggleFullscreen() }, t.desktopFullscreen),
        h('button', { class: 'btn', onclick: () => void disconnect() }, t.desktopDisconnect));
    };
    const paintOverlay = (state: DesktopSnapshot) => {
      if (state.error) {
        const errors = t.desktopErrors as Record<string, string>;
        replaceChildren(overlay,
          h('p', {}, errors[state.error] ?? t.desktopErrors.failed),
          h('button', { class: 'btn primary', onclick: () => controller?.retry() }, state.error === 'connectionBusy' ? t.desktopTakeover : t.desktopRetry));
        overlay.hidden = false;
      } else if (!state.ready) {
        replaceChildren(overlay, h('p', {}, state.status === 'reconnecting' ? t.desktopReconnecting : t.desktopConnecting));
        overlay.hidden = false;
      } else overlay.hidden = true;
    };

    const toggleFullscreen = async () => {
      try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await content.requestFullscreen();
      } catch { /* 浏览器拒绝全屏时保持原样。 */ }
    };
    // 全屏时请求键盘锁定,Ctrl+W、Cmd+Tab 以外的系统快捷键才会发给远程电脑(仅 Chromium 支持)。
    const onFullscreen = () => {
      const keyboard = (navigator as Navigator & { keyboard?: { lock?: () => Promise<void>; unlock?: () => void } }).keyboard;
      if (document.fullscreenElement === content) void keyboard?.lock?.().catch(() => undefined);
      else keyboard?.unlock?.();
    };
    document.addEventListener('fullscreenchange', onFullscreen);

    const disconnect = async () => {
      const current = controller;
      controller = null;
      await current?.close();
      showDevices();
    };

    controller = new WebDesktopController(api!, device.deviceId, content, loadPrefs(), (state) => {
      try { storage?.setItem(prefKey, JSON.stringify(state.preferences)); } catch { /* 偏好只是便利。 */ }
      paintToolbar(state);
      paintOverlay(state);
    });
    paintToolbar(controller.snapshot);
    paintOverlay(controller.snapshot);
    stage.focus();
    return {
      dispose() {
        document.removeEventListener('fullscreenchange', onFullscreen);
        const current = controller;
        controller = null;
        if (current) void current.close();
      },
    };
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  const existing = storage ? loadProfile(storage) : null;
  if (existing && !location.hash.includes('#/join?')) startSession(existing);
  else showJoin();
}
