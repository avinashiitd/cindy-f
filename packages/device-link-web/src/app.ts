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

  // ── 电脑列表 ────────────────────────────────────────────────────────────
  function showDevices(): void {
    setView(() => {
      const others = [...devices.values()].filter((device) => !device.isSelf)
        .sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
      replaceChildren(shell, header(),
        h('main', { class: 'panel' },
          h('h1', {}, t.devices),
          others.length === 0 ? h('p', { class: 'note' }, t.noDevices) : null,
          h('ul', { class: 'list' }, ...others.map((device) => h('li', {},
            h('button', {
              class: 'item', disabled: !device.online || !device.remoteControlEnabled,
              onclick: () => showSessions(device),
            },
            h('span', { class: 'item-main' }, h('strong', {}, device.name),
              h('span', { class: 'sub' }, [device.platform, device.appVersion].filter(Boolean).join(' · '))),
            h('span', { class: `pill ${device.online ? 'ok' : 'muted'}` }, device.online ? t.online : t.offline),
            device.online && !device.remoteControlEnabled ? h('span', { class: 'pill warn' }, t.controlOff) : null))))));
    });
  }

  // ── 任务列表 ────────────────────────────────────────────────────────────
  function showSessions(device: DeviceView): void {
    let sessions: RemoteSessionRow[] = [];
    let failed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let alive = true;

    const load = async () => {
      if (!api) return;
      try {
        sessions = await api.listSessions(device.deviceId);
        failed = false;
      } catch {
        failed = true;
      }
      if (alive) render();
    };
    const schedule = () => { clearTimeout(timer); timer = setTimeout(() => void load(), REFRESH_DEBOUNCE_MS); };
    const render = () => replaceChildren(shell,
      header(h('button', { class: 'btn ghost', onclick: showDevices }, `← ${t.back}`)),
      h('main', { class: 'panel' },
        h('div', { class: 'row between' }, h('h1', {}, `${device.name} · ${t.tasks}`),
          h('button', { class: 'btn ghost', onclick: () => void load() }, t.refresh)),
        failed ? h('p', { class: 'note error' }, t.loadFailed) : null,
        !failed && sessions.length === 0 ? h('p', { class: 'note' }, t.noTasks) : null,
        h('ul', { class: 'list' }, ...sessions.map((session) => h('li', {},
          h('button', { class: 'item', onclick: () => showSession(device, session) },
            h('span', { class: 'item-main' }, h('strong', {}, session.title || session.id),
              session.preview ? h('span', { class: 'sub clamp' }, session.preview) : null),
            h('span', { class: 'sub' }, formatTime(session.lastActivityAt ?? session.updatedAt))))))));

    const off = api?.onPush((event) => {
      if (event.from === device.deviceId && event.channel.startsWith('local-db:sessions:')) schedule();
    });
    setView(render, () => { alive = false; clearTimeout(timer); off?.(); void api?.unsubscribe(device.deviceId, ['sessions']).catch(() => undefined); });
    void api?.subscribe(device.deviceId, ['sessions']).catch(() => undefined);
    void load();
  }

  // ── 单个任务 ────────────────────────────────────────────────────────────
  function showSession(device: DeviceView, initial: RemoteSessionRow): void {
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

    const load = async () => {
      if (!api) return;
      try {
        const [fresh, messages, pending, active] = await Promise.all([
          api.getSession(device.deviceId, session.id).catch(() => session),
          api.listMessages(device.deviceId, session.id),
          api.listPendingInteractions(device.deviceId, session.id).catch(() => [] as PendingInteraction[]),
          api.invoke<Array<{ sessionId: string; isTurnRunning?: boolean }>>(device.deviceId, 'maker:list-active').catch(() => []),
        ]);
        session = fresh;
        rows = messages;
        interactions = pending;
        running = active.some((item) => item.sessionId === session.id && item.isTurnRunning);
        error = '';
      } catch {
        error = t.loadFailed;
      }
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
      try {
        await api.sendText(device.deviceId, session, text, newClientId());
        input.value = '';
        error = '';
      } catch (e) {
        error = t.sendFailed + (e instanceof Error ? e.message : '');
      }
      sending = false;
      await load();
    };

    const paint = () => {
      const stickToBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      replaceChildren(log, ...toDisplayMessages(rows).map((message) =>
        h('div', { class: `msg ${message.kind}` },
          message.kind === 'tool' ? h('span', { class: 'pill muted' }, `${t.tool}: ${message.text}`) : h('div', { class: 'bubble' }, message.text))));
      if (stickToBottom) log.scrollTop = log.scrollHeight;
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
      stopButton.hidden = !running;
      runBadge.hidden = !running;
    };

    const stopButton = h('button', { class: 'btn', onclick: () => api && void api.stop(device.deviceId, session.id).then(load, load) }, t.stop);
    const runBadge = h('span', { class: 'pill ok' }, t.running);
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); void send(); }
    });

    const off = api?.onPush((event) => {
      if (event.from !== device.deviceId) return;
      if (event.channel.startsWith('maker:') || event.channel.startsWith('local-db:messages:') || event.channel.startsWith('local-db:sessions:')) schedule();
    });

    setView(() => {
      replaceChildren(shell,
        header(h('button', { class: 'btn ghost', onclick: () => showSessions(device) }, `← ${t.back}`)),
        h('main', { class: 'panel chat' },
          h('div', { class: 'row between' }, h('h1', {}, session.title || session.id), h('div', { class: 'row' }, runBadge, stopButton)),
          log, side,
          h('div', { class: 'row composer-row' }, input, h('button', { class: 'btn primary', onclick: () => void send() }, t.send))));
      paint();
    }, () => { alive = false; clearTimeout(timer); off?.(); void api?.unsubscribe(device.deviceId, [topic]).catch(() => undefined); });

    void (async () => {
      try {
        await api?.openLink(device.deviceId);
        await api?.subscribe(device.deviceId, [topic]);
      } catch (e) {
        error = e instanceof RemoteError && e.code === 'REMOTE_DISABLED' ? t.remoteOff : t.loadFailed;
      }
      await load();
    })();
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  const existing = storage ? loadProfile(storage) : null;
  if (existing && !location.hash.includes('#/join?')) startSession(existing);
  else showJoin();
}
