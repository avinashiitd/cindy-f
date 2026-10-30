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
import { renderMarkdown } from './markdown';
import { toDisplayMessages, type RemoteMessageRow } from './messages';
import { agentKindOf, findModelOption, modelKey, modelOptions, needsFullAccessConfirmation, PERMISSION_MODES } from './models';
import { clearProfile, loadProfile, saveProfile, type WebRelayProfile } from './profile';
import type { WebAttachment } from './attachments';
import { RemoteApi, RemoteError, type AgentKindName, type PendingInteraction, type ProviderLike, type RemoteSessionRow } from './remote';
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
  type Mode = 'tasks' | 'desktop' | 'files';
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
              h('button', { class: `tab${selected?.mode === 'files' ? ' on' : ''}`, role: 'tab', onclick: () => openDevice(device.deviceId, 'files') }, t.tabFiles),
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
      pane = mode === 'tasks' ? mountTasks(main, device)
        : mode === 'files' ? mountFiles(main, device)
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
        h('div', { class: 'row' },
          h('button', { class: 'btn ghost', onclick: () => void load() }, t.refresh),
          h('button', { class: 'btn primary', onclick: () => void showNewTask() }, t.newTask))),
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

    /** 新建任务:选 Agent、模型、工作目录、权限,写下第一条消息,创建后直接发送。 */
    const showNewTask = async () => {
      if (!api) return;
      chat?.dispose();
      chat = null;
      activeId = null;
      paintList();
      const [agentsRaw, providersRaw, workdirsRaw] = await Promise.all([
        api.listAvailableAgents(device.deviceId).catch(() => ['claude-code'] as AgentKindName[]),
        api.listProviders(device.deviceId).catch(() => ({ providers: [] as ProviderLike[] })),
        api.recentWorkdirs(device.deviceId).catch(() => [] as Array<{ path: string }>),
      ]);
      if (!alive) return;
      const agents = (Array.isArray(agentsRaw) && agentsRaw.length ? agentsRaw : ['claude-code']) as AgentKindName[];
      const agentLabel: Record<AgentKindName, string> = { 'claude-code': 'Claude Code', codex: 'Codex', pi: 'Pi' };
      const agentSelect = h('select', { id: 'nt-agent', 'aria-label': t.newTaskAgent }, ...agents.map((a) => h('option', { value: a }, agentLabel[a] ?? a)));
      const modelSelect = h('select', { id: 'nt-model', 'aria-label': t.newTaskModel });
      const folder = h('input', { id: 'nt-folder', type: 'text', list: 'nt-folders', placeholder: t.newTaskFolderHint, autocomplete: 'off', spellcheck: false });
      const datalist = h('datalist', { id: 'nt-folders' }, ...workdirsRaw.slice(0, 30).map((w) => h('option', { value: w.path })));
      if (workdirsRaw[0]) folder.value = workdirsRaw[0].path;
      const permission = h('select', { id: 'nt-permission', 'aria-label': t.newTaskPermission }, ...PERMISSION_MODES.map((m) => h('option', { value: m }, t.permissionModes[m])));
      const prompt = h('textarea', { id: 'nt-prompt', rows: 5, placeholder: t.newTaskPrompt });
      const message = h('p', { class: 'note', role: 'status' });
      const create = h('button', { class: 'btn primary', type: 'button' }, t.newTaskCreate);
      const fillModels = () => {
        const options = modelOptions(providersRaw.providers, agentSelect.value as AgentKindName);
        replaceChildren(modelSelect, ...options.map((o) => h('option', { value: o.key }, options.some((x) => x !== o && x.modelId === o.modelId) ? `${o.label} · ${o.providerName}` : o.label)));
        message.textContent = options.length ? '' : t.newTaskNoModels;
        create.disabled = options.length === 0;
      };
      agentSelect.addEventListener('change', fillModels);
      fillModels();
      create.addEventListener('click', async () => {
        const options = modelOptions(providersRaw.providers, agentSelect.value as AgentKindName);
        const model = options.find((o) => o.key === modelSelect.value);
        const text = prompt.value.trim();
        const workingDir = folder.value.trim();
        if (!model || !text || !workingDir) return;
        create.disabled = true;
        try {
          const id = newClientId();
          if (permission.value === 'bypassPermissions' && !window.confirm(t.fullAccessConfirm)) { create.disabled = false; return; }
          await api!.createSession(device.deviceId, {
            id, agentKind: agentSelect.value as AgentKindName, workspaceKind: 'project', model: model.modelId, providerId: model.providerId,
            permissionMode: permission.value, fastMode: false, workingDir,
          });
          const created = await api!.getSession(device.deviceId, id);
          await api!.sendText(device.deviceId, created, text, newClientId());
          await load();
          if (alive) openChat(created);
        } catch (e) {
          message.className = 'note error';
          message.textContent = t.newTaskFailed + (e instanceof Error ? e.message : '');
          create.disabled = false;
        }
      });
      replaceChildren(chatEl, h('div', { class: 'chat newtask' }, h('h1', {}, t.newTask),
        h('label', { for: 'nt-agent' }, t.newTaskAgent), agentSelect,
        h('label', { for: 'nt-model' }, t.newTaskModel), modelSelect,
        h('label', { for: 'nt-folder' }, t.newTaskFolder), folder, datalist,
        h('label', { for: 'nt-permission' }, t.newTaskPermission), permission,
        h('label', { for: 'nt-prompt' }, t.newTaskPrompt), prompt,
        h('div', { class: 'row' }, create), message));
    };

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
    // 附件:先上传到中转,发送时随消息带上;上传中的不能发送。
    const attached: Array<{ id: number; name: string; attachment?: WebAttachment; error?: string }> = [];
    let attachSeq = 0;
    const chips = h('div', { class: 'chips' });
    const paintChips = () => replaceChildren(chips, ...attached.map((item) => h('span', { class: `chip${item.error ? ' error' : ''}` },
      item.error ? `${item.name} — ${item.error}` : item.attachment ? item.name : `${item.name} · ${t.attachUploading}`,
      h('button', { class: 'chip-x', 'aria-label': '×', onclick: () => { attached.splice(attached.indexOf(item), 1); paintChips(); } }, '×'))));
    const addFiles = (files: Iterable<File>) => {
      for (const file of files) {
        const item: (typeof attached)[number] = { id: ++attachSeq, name: file.name || 'file' };
        attached.push(item);
        void api?.uploadAttachment(file, item.name)
          .then((attachment) => { item.attachment = attachment; })
          .catch((e) => { item.error = e instanceof RemoteError && e.code === 'FILE_TOO_LARGE' ? t.attachTooLarge : t.attachFailed + (e instanceof Error ? e.message : ''); })
          .finally(paintChips);
      }
      paintChips();
    };
    const filePicker = h('input', { type: 'file', multiple: true, hidden: true });
    filePicker.addEventListener('change', () => { if (filePicker.files) addFiles(filePicker.files); filePicker.value = ''; });
    input.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      if (files.length) { event.preventDefault(); addFiles(files); }
    });
    const side = h('div', { class: 'side' });
    const runBadge = h('span', { class: 'pill ok' }, t.running);
    const stopButton = h('button', { class: 'btn', onclick: () => api && void api.stop(device.deviceId, session.id).then(load, load) }, t.stop);
    const titleEl = h('h1', {}, session.title || session.id);
    let providers: ProviderLike[] = [];
    const controls = h('div', { class: 'row controls' });
    const setting = async (action: () => Promise<unknown>) => {
      try { await action(); error = ''; } catch (e) { error = t.settingFailed + (e instanceof Error ? e.message : ''); }
      await load();
    };
    const paintControls = () => {
      const options = modelOptions(providers, agentKindOf(session.agentKind));
      const current = findModelOption(options, session.model, session.providerId);
      const modelSelect = h('select', { 'aria-label': t.newTaskModel },
        ...(current ? [] : [h('option', { value: '' }, session.model)]),
        ...options.map((o) => h('option', { value: o.key }, options.some((x) => x !== o && x.modelId === o.modelId) ? `${o.label} · ${o.providerName}` : o.label)));
      modelSelect.value = current?.key ?? '';
      modelSelect.addEventListener('change', () => {
        const next = options.find((o) => o.key === modelSelect.value);
        if (next && api) void setting(() => api!.setModel(device.deviceId, session.id, next.modelId, next.providerId));
      });
      const efforts = current?.efforts ?? [];
      const effortSelect = efforts.length ? h('select', { 'aria-label': t.effort }, ...efforts.map((e) => h('option', { value: e }, e))) : null;
      if (effortSelect) {
        effortSelect.value = efforts.includes(session.effort) ? session.effort : efforts[0];
        effortSelect.addEventListener('change', () => api && void setting(() => api!.setEffort(device.deviceId, session.id, effortSelect.value)));
      }
      const permissionSelect = h('select', { 'aria-label': t.newTaskPermission },
        ...PERMISSION_MODES.map((m) => h('option', { value: m }, t.permissionModes[m])));
      permissionSelect.value = (PERMISSION_MODES as readonly string[]).includes(session.permissionMode) ? session.permissionMode : 'ask';
      permissionSelect.addEventListener('change', () => {
        const next = permissionSelect.value;
        if (needsFullAccessConfirmation(session.permissionMode, next) && !window.confirm(t.fullAccessConfirm)) {
          permissionSelect.value = session.permissionMode;
          return;
        }
        if (api) void setting(() => api!.setPermissionMode(device.deviceId, session.id, next));
      });
      replaceChildren(controls, modelSelect, effortSelect, permissionSelect);
    };

    const load = async () => {
      if (!api) return;
      try {
        const [fresh, messages, pending, active] = await Promise.all([
          api.getSession(device.deviceId, session.id).catch(() => session),
          api.listMessages(device.deviceId, session.id),
          api.listPendingInteractions(device.deviceId, session.id).catch(() => [] as PendingInteraction[]),
          api.invoke<Array<{ sessionId: string; isTurnRunning?: boolean }>>(device.deviceId, 'maker:list-active').catch(() => []),
        ]);
        if (!providers.length) providers = (await api.listProviders(device.deviceId).catch(() => ({ providers: [] as ProviderLike[] }))).providers;
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
    /** Agent 的提问:每题单选 / 多选(可加自己的回答);多选答案是标签数组的 JSON。 */
    const askCard = (request: PendingInteraction['request']): HTMLElement => {
      const questions = Array.isArray(request.questions) ? request.questions as Array<{ question?: string; header?: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean }> : [];
      const picked = new Map<string, Set<string>>();
      const custom = new Map<string, HTMLInputElement>();
      const blocks = questions.filter((q) => typeof q.question === 'string').map((q) => {
        const key = q.question!;
        const chosen = new Set<string>();
        picked.set(key, chosen);
        const free = h('input', { type: 'text', placeholder: t.askCustom });
        custom.set(key, free);
        return h('fieldset', { class: 'ask' },
          h('legend', {}, q.header ? `${q.header}: ${q.question}` : q.question),
          ...(q.options ?? []).map((option) => h('label', { class: 'choice' },
            h('input', { type: q.multiSelect ? 'checkbox' : 'radio', name: `ask-${key}`, onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              if (!q.multiSelect) { chosen.clear(); free.value = ''; }
              if (on) chosen.add(option.label); else chosen.delete(option.label);
            } }),
            h('span', {}, option.label, option.description ? h('span', { class: 'sub' }, ` — ${option.description}`) : null))),
          free);
      });
      const submit = async () => {
        if (!api || typeof request.requestId !== 'string') return;
        const answers: Record<string, string> = {};
        for (const q of questions) {
          if (typeof q.question !== 'string') continue;
          const labels = [...(picked.get(q.question) ?? [])];
          const typed = custom.get(q.question)?.value.trim() ?? '';
          if (q.multiSelect) { if (typed) labels.push(typed); if (labels.length) answers[q.question] = JSON.stringify(labels); }
          else if (typed || labels[0]) answers[q.question] = typed || labels[0];
        }
        try { await api.answerQuestions(device.deviceId, request.requestId, answers); } catch (e) { error = t.sendFailed + (e instanceof Error ? e.message : ''); }
        await load();
      };
      return h('div', { class: 'card' }, ...blocks, h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void submit() }, t.askQuestionSubmit)));
    };
    /** 计划审阅:批准(原样采用计划)或要求修改(附意见)。 */
    const planCard = (request: PendingInteraction['request']): HTMLElement => {
      const plan = typeof request.plan === 'string' ? request.plan : '';
      const feedback = h('textarea', { rows: 2, placeholder: t.planFeedback });
      const decide = async (approved: boolean) => {
        if (!api || typeof request.requestId !== 'string') return;
        try { await api.resolvePlan(device.deviceId, request.requestId, approved, plan, feedback.value); } catch (e) { error = t.sendFailed + (e instanceof Error ? e.message : ''); }
        await load();
      };
      return h('div', { class: 'card' }, h('strong', {}, t.planReviewTitle), h('div', { class: 'md plan' }, renderMarkdown(plan)), feedback,
        h('div', { class: 'row' }, h('button', { class: 'btn primary', onclick: () => void decide(true) }, t.planApprove), h('button', { class: 'btn', onclick: () => void decide(false) }, t.planReject)));
    };
    const send = async () => {
      const text = input.value.trim();
      const ready = attached.filter((item) => item.attachment).map((item) => item.attachment!);
      const uploading = attached.some((item) => !item.attachment && !item.error);
      if ((!text && !ready.length) || uploading || sending || !api) return;
      sending = true;
      try {
        await api.sendText(device.deviceId, session, text, newClientId(), new Date(), ready);
        input.value = ''; error = '';
        attached.length = 0; paintChips();
      }
      catch (e) { error = t.sendFailed + (e instanceof Error ? e.message : ''); }
      sending = false;
      await load();
    };
    const paint = () => {
      const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      titleEl.textContent = session.title || session.id;
      paintControls();
      replaceChildren(log, ...toDisplayMessages(rows).map((message) =>
        h('div', { class: `msg ${message.kind}` },
          message.kind === 'tool'
            ? h('span', { class: 'pill muted tool' }, `${t.tool}: ${message.text}${message.detail ? ` · ${message.detail}` : ''}`)
            : message.kind === 'assistant'
              ? h('div', { class: 'bubble md' }, renderMarkdown(message.text))
              : h('div', { class: 'bubble' }, message.text,
                ...(message.attachments ?? []).map((name) => h('span', { class: 'attached' }, `📎 ${name}`))))));
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
          if (request.kind === 'ask_user_question') return askCard(request);
          if (request.kind === 'plan_review') return planCard(request);
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
    const chatEl = h('div', { class: 'chat' },
      h('div', { class: 'row between' }, titleEl, h('div', { class: 'row' }, runBadge, stopButton)),
      controls, log, side, chips,
      h('div', { class: 'row composer-row' },
        h('button', { class: 'btn ghost', onclick: () => filePicker.click(), 'aria-label': t.attach, title: t.attach }, '📎'), filePicker,
        input, h('button', { class: 'btn primary', onclick: () => void send() }, t.send)));
    chatEl.addEventListener('dragover', (event) => { if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); chatEl.classList.add('dropping'); } });
    chatEl.addEventListener('dragleave', () => chatEl.classList.remove('dropping'));
    chatEl.addEventListener('drop', (event) => {
      chatEl.classList.remove('dropping');
      if (event.dataTransfer?.files.length) { event.preventDefault(); addFiles(event.dataTransfer.files); }
    });
    replaceChildren(container, chatEl);
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

  // ── 文件:浏览电脑上某个目录,预览文本,下载任意文件 ───────────────────────────────
  function mountFiles(container: HTMLElement, device: DeviceView): { dispose(): void } {
    let alive = true;
    let workdir = '';
    let relPath = '';
    let entries: Array<{ name: string; relPath: string; type: 'file' | 'directory'; size: number; mtimeMs: number }> = [];
    let selectedFile: string | null = null;
    let download: AbortController | null = null;
    const folder = h('input', { type: 'text', list: 'files-folders', placeholder: t.filesPickFolder, spellcheck: false, autocomplete: 'off' });
    const datalist = h('datalist', { id: 'files-folders' });
    const listEl = h('div', { class: 'file-list' });
    const previewEl = h('div', { class: 'file-preview' }, h('p', { class: 'note empty' }, t.filesPickFolder));
    const crumbs = h('div', { class: 'crumbs' });
    replaceChildren(container, h('div', { class: 'files' },
      h('div', { class: 'row files-bar' }, h('label', {}, t.filesFolder), folder, datalist,
        h('button', { class: 'btn', onclick: () => { workdir = folder.value.trim(); relPath = ''; void openDir(); } }, t.filesOpen)),
      crumbs, h('div', { class: 'split files-split' }, listEl, previewEl)));
    folder.addEventListener('keydown', (e) => { if (e.key === 'Enter') { workdir = folder.value.trim(); relPath = ''; void openDir(); } });

    const size = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    const paintCrumbs = () => {
      const parts = relPath ? relPath.split('/') : [];
      replaceChildren(crumbs,
        h('button', { class: 'crumb', onclick: () => { relPath = ''; void openDir(); } }, workdir || '/'),
        ...parts.map((part, i) => h('button', { class: 'crumb', onclick: () => { relPath = parts.slice(0, i + 1).join('/'); void openDir(); } }, `/ ${part}`)));
    };
    const paintList = (failed = false) => replaceChildren(listEl,
      failed ? h('p', { class: 'note error' }, t.loadFailed) : null,
      !failed && entries.length === 0 ? h('p', { class: 'note' }, t.filesEmpty) : null,
      h('ul', { class: 'list' }, ...entries.map((entry) => h('li', {},
        h('button', { class: `item file-item${entry.relPath === selectedFile ? ' active' : ''}`, onclick: () => entry.type === 'directory' ? (relPath = entry.relPath, void openDir()) : void openFile(entry) },
          h('span', { class: 'item-main' }, h('strong', {}, `${entry.type === 'directory' ? '📁' : '📄'} ${entry.name}`)),
          entry.type === 'file' ? h('span', { class: 'sub' }, size(entry.size)) : null)))));
    const openDir = async () => {
      if (!api || !workdir) return;
      selectedFile = null;
      paintCrumbs();
      try {
        const list = await api.listDir(device.deviceId, workdir, relPath);
        entries = (Array.isArray(list) ? list : []).slice().sort((a, b) => Number(b.type === 'directory') - Number(a.type === 'directory') || a.name.localeCompare(b.name));
        if (alive) paintList();
      } catch { if (alive) { entries = []; paintList(true); } }
    };
    const startDownload = async (entry: { relPath: string; name: string }, status: HTMLElement) => {
      if (!api) return;
      download?.abort();
      const controller = new AbortController();
      download = controller;
      status.textContent = t.filesPreparing;
      try {
        const url = await api.exportFile(device.deviceId, workdir, entry.relPath, (uploaded, total) => {
          status.textContent = total ? `${t.filesPreparing} ${Math.floor((uploaded / total) * 100)}%` : t.filesPreparing;
        }, controller.signal);
        const a = h('a', { href: url, download: entry.name, rel: 'noopener' });
        document.body.append(a);
        a.click();
        a.remove();
        status.textContent = '';
      } catch (e) {
        if (!controller.signal.aborted) status.textContent = t.filesDownloadFailed + (e instanceof Error ? e.message : '');
      }
    };
    const openFile = async (entry: { relPath: string; name: string; size: number }) => {
      if (!api) return;
      selectedFile = entry.relPath;
      paintList();
      const status = h('span', { class: 'sub' });
      const head = h('div', { class: 'row between' }, h('strong', {}, entry.name),
        h('div', { class: 'row' }, status, h('button', { class: 'btn', onclick: () => void startDownload(entry, status) }, t.filesDownload)));
      replaceChildren(previewEl, head, h('p', { class: 'note' }, t.desktopConnecting));
      try {
        const result = await api.readFile(device.deviceId, workdir, entry.relPath);
        if (!alive || selectedFile !== entry.relPath) return;
        if (!result.ok || result.data.contentEncoding) { replaceChildren(previewEl, head, h('p', { class: 'note' }, t.filesBinary)); return; }
        const pre = h('pre', { class: 'file-text' });
        pre.textContent = result.data.content;
        replaceChildren(previewEl, head, result.data.truncated ? h('p', { class: 'note' }, t.filesTruncated) : null,
          entry.name.toLowerCase().endsWith('.md') ? h('div', { class: 'md file-md' }, renderMarkdown(result.data.content)) : pre);
      } catch { if (alive) replaceChildren(previewEl, head, h('p', { class: 'note' }, t.filesBinary)); }
    };
    void api?.recentWorkdirs(device.deviceId).then((list) => {
      if (!alive) return;
      replaceChildren(datalist, ...list.slice(0, 30).map((w) => h('option', { value: w.path })));
      if (list[0] && !folder.value) { folder.value = list[0].path; workdir = list[0].path; void openDir(); }
    }).catch(() => undefined);
    return { dispose() { alive = false; download?.abort(); } };
  }

  // ── 远程桌面 ────────────────────────────────────────────────────────────
  function mountDesktop(container: HTMLElement, device: DeviceView): { dispose(): void } {
    const prefKey = `cindy.web.desktop.${device.deviceId}`;
    const loadPrefs = (): DesktopPreferences => {
      try {
        const raw = JSON.parse(storage?.getItem(prefKey) ?? 'null') as Partial<DesktopPreferences> | null;
        return {
          lockOnExit: raw?.lockOnExit !== false,
          privacyScreen: raw?.privacyScreen !== false,
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
    const tools = h('div', { class: 'viewer-toolbar secondary' });
    const notice = h('div', { class: 'viewer-notice', role: 'status', hidden: true });
    replaceChildren(container, h('div', { class: 'viewer' }, toolbar, tools, notice, content));
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const say = (text: string, extra?: Node) => {
      clearTimeout(noticeTimer);
      replaceChildren(notice, h('span', {}, text), extra ?? null, h('button', { class: 'btn ghost', onclick: () => { notice.hidden = true; } }, '×'));
      notice.hidden = false;
      if (!extra) noticeTimer = setTimeout(() => { notice.hidden = true; }, 5000);
    };
    const clipboardError = (e: unknown) => {
      const code = e instanceof Error ? e.message : '';
      say(code.includes('EMPTY') ? t.desktopClipboardEmpty : code.includes('TOO_LONG') ? t.desktopClipboardTooLong : t.desktopClipboardFailed);
    };
    // 剪贴板:能用异步剪贴板 API(https)就直接读写,否则退回手动复制 / 输入框。
    const copyFromRemote = async () => {
      try {
        const text = await controller!.copyFromRemote();
        try { await navigator.clipboard.writeText(text); say(t.desktopCopied); }
        catch {
          const area = h('textarea', { class: 'manual-copy', rows: 4, readonly: true });
          area.value = text;
          say(t.desktopClipboardManual, area);
          area.select();
        }
      } catch (e) { clipboardError(e); }
    };
    const pasteToRemote = async () => {
      let text: string | null = null;
      try { text = await navigator.clipboard.readText(); } catch { text = window.prompt(t.desktopPastePrompt) ?? null; }
      if (text === null) return;
      try { await controller!.pasteToRemote(text); say(t.desktopPasted); } catch (e) { clipboardError(e); }
    };
    const mac = (caps: DesktopSnapshot['caps']) => caps?.platform === 'darwin';
    const keyCombos = (caps: DesktopSnapshot['caps']): Array<[string, string[]]> => mac(caps)
      ? [['⌘ Tab', ['MetaLeft', 'Tab']], ['⌘ Space', ['MetaLeft', 'Space']], ['⌘ Q', ['MetaLeft', 'KeyQ']], ['⌘ W', ['MetaLeft', 'KeyW']], ['⌃ ⌘ Q (lock)', ['ControlLeft', 'MetaLeft', 'KeyQ']]]
      : [['Ctrl+Alt+Delete', ['ControlLeft', 'AltLeft', 'Delete']], ['Alt+Tab', ['AltLeft', 'Tab']], ['Alt+F4', ['AltLeft', 'F4']], ['Win', ['MetaLeft']], ['Ctrl+W', ['ControlLeft', 'KeyW']], ['Ctrl+Esc', ['ControlLeft', 'Escape']]];
    let modes: Awaited<ReturnType<WebDesktopController['displayModes']>> = [];
    let windows: Awaited<ReturnType<WebDesktopController['listWindows']>> = [];
    let modesLease = '';
    const paintTools = (state: DesktopSnapshot) => {
      const caps = state.caps;
      const can = state.ready && state.controlling;
      const combos = keyCombos(caps);
      const keysSelect = h('select', { 'aria-label': t.desktopKeys, disabled: !can },
        h('option', { value: '' }, t.desktopKeys), ...combos.map(([label], i) => h('option', { value: String(i) }, label)));
      keysSelect.addEventListener('change', () => {
        const combo = combos[Number(keysSelect.value)];
        if (combo) controller?.keys(combo[1]);
        keysSelect.value = '';
      });
      const modeSelect = caps?.displayModes && caps.resolutionRestore ? h('select', { 'aria-label': t.desktopResolution, disabled: !can || state.busy },
        h('option', { value: '' }, t.desktopResolution),
        ...modes.map((m) => h('option', { value: m.id }, `${m.width} × ${m.height}${m.current ? ' ✓' : ''}`))) : null;
      modeSelect?.addEventListener('focus', () => void loadModes(true));
      modeSelect?.addEventListener('change', () => {
        const mode = modes.find((m) => m.id === modeSelect.value);
        if (mode) void controller?.resolution(mode).then(() => loadModes(true)).catch(() => say(t.desktopErrors.failed));
      });
      const windowSelect = caps?.windowActions ? h('select', { 'aria-label': t.desktopWindows, disabled: !can },
        h('option', { value: '' }, t.desktopWindows),
        h('option', { value: '__desktop' }, t.desktopShowDesktop),
        ...windows.map((w) => h('option', { value: w.id }, `${w.app}${w.title ? ` — ${w.title}` : ''}`.slice(0, 80)))) : null;
      windowSelect?.addEventListener('focus', () => void controller?.listWindows().then((list) => { windows = list; paintTools(controller!.snapshot); }).catch(() => undefined));
      windowSelect?.addEventListener('change', () => {
        const id = windowSelect.value;
        if (id === '__desktop') void controller?.showDesktop().catch(() => undefined);
        else if (id) void controller?.activateWindow(id).catch(() => undefined);
        windowSelect.value = '';
      });
      replaceChildren(tools,
        h('button', { class: 'btn ghost', onclick: () => controller?.zoom('out'), disabled: !state.ready, 'aria-label': t.desktopZoomOut }, '−'),
        h('button', { class: 'btn ghost', onclick: () => controller?.zoom('in'), disabled: !state.ready, 'aria-label': t.desktopZoomIn }, '+'),
        caps?.clipboardText !== false ? h('button', { class: 'btn ghost', onclick: () => void copyFromRemote(), disabled: !can }, t.desktopCopy) : null,
        caps?.clipboardText !== false ? h('button', { class: 'btn ghost', onclick: () => void pasteToRemote(), disabled: !can }, t.desktopPaste) : null,
        keysSelect, modeSelect, windowSelect,
        caps?.privacyScreen ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.privacy ?? state.preferences.privacyScreen, disabled: !can,
          onchange: (e: Event) => controller?.preferences({ privacyScreen: (e.target as HTMLInputElement).checked }) }), t.desktopPrivacy) : null,
        caps?.hostMute ? h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.hostMuted === true, disabled: !can,
          onchange: (e: Event) => void controller?.setHostMute((e.target as HTMLInputElement).checked).catch(() => say(t.desktopErrors.failed)) }), t.desktopHostMute) : null);
    };
    const loadModes = async (force = false) => {
      const snap = controller?.snapshot;
      if (!controller || !snap?.ready || !snap.caps?.displayModes) return;
      if (!force && modesLease === snap.displayId) return;
      modesLease = snap.displayId;
      try { modes = await controller.displayModes(); } catch { modes = []; }
      if (controller) paintTools(controller.snapshot);
    };
    const onVisibility = () => controller?.setHidden(document.visibilityState === 'hidden');
    document.addEventListener('visibilitychange', onVisibility);

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
      paintTools(state);
      paintOverlay(state);
      if (state.ready) void loadModes();
    });
    paintToolbar(controller.snapshot);
    paintTools(controller.snapshot);
    paintOverlay(controller.snapshot);
    stage.focus();
    return {
      dispose() {
        document.removeEventListener('fullscreenchange', onFullscreen);
        document.removeEventListener('visibilitychange', onVisibility);
        clearTimeout(noticeTimer);
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
