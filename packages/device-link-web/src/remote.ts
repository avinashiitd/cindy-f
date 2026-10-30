/**
 * 对一台被控电脑的远程调用:列表、读消息、发送、停止、审批。
 * 全部走 device-link 隧道的白名单 channel(`REMOTE_INVOKE_ALLOWLIST`),网页没有任何超出手机的能力。
 */
import { PROTOCOL_VERSION, type DeviceLinkClient, type DeviceView, type Envelope } from '@cindy/device-link';

import { buildWebAttachment, extOf, hashBlob, persistedRefs, WEB_ATTACHMENT_MAX_BYTES, type WebAttachment } from './attachments';
import type { RemoteMessageRow } from './messages';
import { WEB_APP_VERSION } from './join';

export interface RemoteSessionRow {
  id: string;
  title: string;
  status: string;
  model: string;
  workingDir: string | null;
  permissionMode: string;
  effort: string;
  agentKind: 'cc' | 'codex' | 'pi';
  fastMode?: boolean | 'ultrafast';
  sdkSessionId?: string | null;
  providerId?: string | null;
  remoteHostId?: string | null;
  preview?: string | null;
  updatedAt: string;
  lastActivityAt?: string | null;
}

export interface PendingInteraction {
  request: { kind?: string; requestId?: string; [key: string]: unknown };
}

export interface PushEvent {
  from: string;
  channel: string;
  payload: unknown;
}

export type AgentKindName = 'claude-code' | 'codex' | 'pi';

/** `maker:provider:list` 里本页用到的字段(其余字段忽略)。 */
export interface ProviderLike {
  id: string;
  name: string;
  agents: AgentKindName[];
  connected: boolean;
  suspended?: boolean;
  models: Partial<Record<AgentKindName, Array<{ id: string; name: string; efforts?: string[]; disabled?: boolean }>>>;
}

export interface CreateSessionInput {
  id: string;
  agentKind: AgentKindName;
  workspaceKind: 'project' | 'dialogue';
  model: string;
  permissionMode: string;
  fastMode: boolean;
  effort?: string;
  providerId?: string;
  workingDir?: string;
}

export class RemoteError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RemoteError';
  }
}

const LIST_LIMIT = 100;
const ONLINE_WAIT_MS = 15_000;
const EXPORT_POLL_MS = 700;

export interface ScheduleRow {
  id: string;
  name: string;
  prompt: string;
  status: 'active' | 'paused' | 'expired' | string;
  cronExpr?: string;
  manual?: boolean;
  recurring?: boolean;
  workingDir?: string | null;
  nextFireAt?: number | null;
  lastFiredAt?: number | null;
}

export interface ScheduleRunRow {
  id: string;
  sessionId?: string | null;
  status: string;
  firedAt: number;
  finishedAt?: number | null;
  resultText?: string | null;
}

export interface RemoteDirEntry {
  name: string;
  relPath: string;
  type: 'file' | 'directory';
  size: number;
  mtimeMs: number;
}

/** 这个浏览器作为控制端对被控端声明的信息。不声明任何可选能力,被控端按最保守的旧格式回复。 */
function controllerInfo(deviceName: string) {
  return { controllerName: deviceName, protocolVersion: PROTOCOL_VERSION, appVersion: WEB_APP_VERSION, capabilities: [] as string[] };
}

export class RemoteApi {
  private readonly opened = new Set<string>();

  constructor(
    private readonly client: DeviceLinkClient,
    private readonly baseUrl: string,
    private readonly credential: string,
    private readonly deviceName: string,
    private readonly fetchFn: typeof fetch = (url, init) => fetch(url, init),
  ) {
    // 页面刷新或断线后,被控端可能还按旧页面的可靠传输状态回复;本端链路未就绪时这些回复会被丢弃。
    // 共享客户端为此提供通知,与手机一样收到后重建控制链路,被控端随即重放未确认的回复。
    client.onReliableFrameBeforeLink((deviceId) => {
      this.opened.delete(deviceId);
      void this.openLink(deviceId).catch(() => undefined);
      return true;
    });
  }

  /** 设备列表(REST):与官方中转同形,含在线状态与是否允许被控。 */
  async listDevices(): Promise<DeviceView[]> {
    const res = await this.fetchFn(`${this.baseUrl}/api/device-link/devices`, {
      headers: { Authorization: `CindyRelay ${this.credential}` },
    });
    if (!res.ok) throw new RemoteError(res.status === 401 ? 'UNAUTHORIZED' : 'FAILED', `devices request failed (${res.status})`);
    const body = (await res.json()) as { devices?: DeviceView[] };
    return Array.isArray(body.devices) ? body.devices : [];
  }

  /** 刚打开页面或刚断线重连时连接还没就绪:先等它在线,而不是立刻失败。 */
  private async online(): Promise<void> {
    if (this.client.getStatus() !== 'online') await this.client.waitUntilOnline(ONLINE_WAIT_MS);
  }

  async invoke<T>(deviceId: string, channel: string, args: unknown[] = []): Promise<T> {
    await this.online();
    const result = await this.client.invoke(deviceId, { channel, args });
    if (!result.ok) throw new RemoteError(result.error.code, result.error.message);
    return result.result as T;
  }

  /** 进入实时操作:建立控制链路(被控电脑会显示「正在被控」)。同一台电脑只建一次。 */
  async openLink(deviceId: string): Promise<void> {
    if (this.opened.has(deviceId)) return;
    await this.online();
    await this.client.openLink(deviceId, controllerInfo(this.deviceName));
    this.opened.add(deviceId);
  }

  /** 连接断开后控制链路已失效,下次进入任务时重新建立。 */
  resetLinks(): void {
    this.opened.clear();
  }

  async subscribe(deviceId: string, topics: string[]): Promise<void> {
    await this.invoke(deviceId, 'device-link:subscribe', [{ ...controllerInfo(this.deviceName), topics }]);
  }

  async unsubscribe(deviceId: string, topics: string[]): Promise<void> {
    await this.invoke(deviceId, 'device-link:unsubscribe', [{ topics }]);
  }

  listSessions(deviceId: string): Promise<RemoteSessionRow[]> {
    return this.invoke(deviceId, 'local-db:sessions:list', [LIST_LIMIT, 'active', { includePinned: true, fresh: true }]);
  }

  getSession(deviceId: string, sessionId: string): Promise<RemoteSessionRow> {
    return this.invoke(deviceId, 'local-db:sessions:get', [sessionId]);
  }

  listMessages(deviceId: string, sessionId: string): Promise<RemoteMessageRow[]> {
    return this.invoke(deviceId, 'local-db:messages:list', [sessionId]);
  }

  listPendingInteractions(deviceId: string, sessionId: string): Promise<PendingInteraction[]> {
    return this.invoke(deviceId, 'maker:get-pending-interactions', [sessionId]);
  }

  resolvePermission(deviceId: string, requestId: string, behavior: 'allow' | 'deny'): Promise<unknown> {
    return this.invoke(deviceId, 'maker:resolve-interaction', [requestId, { kind: 'permission', behavior }]);
  }

  stop(deviceId: string, sessionId: string): Promise<unknown> {
    return this.invoke(deviceId, 'maker:input:stop', [sessionId, {}]);
  }

  /** 发送一条文字消息:格式与手机的 `buildQueuedTextMessage` 一致,被控端按它排队与落库。 */
  sendText(deviceId: string, session: RemoteSessionRow, text: string, clientId: string, now = new Date(), attachments: readonly WebAttachment[] = []): Promise<unknown> {
    const trimmed = text.trim();
    const refs = persistedRefs(attachments);
    const agentKind = session.agentKind === 'codex' || session.agentKind === 'pi' ? session.agentKind : 'claude-code';
    const workingDir = session.workingDir || '';
    const item = {
      clientId,
      text: trimmed,
      persistedContent: JSON.stringify({ text: trimmed, images: refs.images, files: refs.files }),
      ...(attachments.length ? { files: [...attachments] } : {}),
      model: session.model,
      effort: session.effort || '',
      permissionMode: session.permissionMode,
      workingDir,
      chatMessage: {
        clientId, role: 'user', content: trimmed, isStreaming: false, createdAt: now.toISOString(),
        ...(refs.images.length ? { images: refs.images } : {}),
        ...(refs.files.length ? { files: refs.files } : {}),
      },
      createOpts: {
        agentKind,
        workingDir,
        model: session.model,
        effort: session.effort || '',
        permissionMode: session.permissionMode,
        ...(session.fastMode !== undefined ? { fastMode: session.fastMode } : {}),
        displayReasoning: 'summarized',
        ...(session.sdkSessionId ? { resumeSessionId: session.sdkSessionId } : {}),
        ...(session.providerId ? { providerId: session.providerId } : {}),
        ...(session.remoteHostId ? { remoteHostId: session.remoteHostId } : {}),
      },
    };
    return this.invoke(deviceId, 'maker:input:enqueue', [session.id, item, { sendAtMs: now.getTime() }]);
  }

  // ── 新建任务与运行设置 ────────────────────────────────────────────────────
  listProviders(deviceId: string): Promise<{ providers: ProviderLike[] }> {
    return this.invoke(deviceId, 'maker:provider:list', [{ capabilities: [] }]);
  }

  listAvailableAgents(deviceId: string): Promise<AgentKindName[]> {
    return this.invoke(deviceId, 'maker:list-available-agents', []);
  }

  recentWorkdirs(deviceId: string): Promise<Array<{ path: string }>> {
    return this.invoke(deviceId, 'local-db:recent-workdirs:list', []);
  }

  createSession(deviceId: string, options: CreateSessionInput): Promise<{ sessionId: string; workDir?: string | null }> {
    return this.invoke(deviceId, 'maker:create-session', [options]);
  }

  setModel(deviceId: string, sessionId: string, model: string, providerId: string | null): Promise<unknown> {
    return this.invoke(deviceId, 'maker:set-model', providerId ? [sessionId, model, providerId] : [sessionId, model]);
  }

  setEffort(deviceId: string, sessionId: string, effort: string): Promise<unknown> {
    return this.invoke(deviceId, 'maker:set-effort', [sessionId, effort]);
  }

  setPermissionMode(deviceId: string, sessionId: string, mode: string): Promise<unknown> {
    return this.invoke(deviceId, 'maker:set-permission-mode', [sessionId, mode]);
  }

  /** 回答 Agent 的提问:多选答案是标签数组的 JSON,与手机、桌面一致。 */
  answerQuestions(deviceId: string, requestId: string, answers: Record<string, string>): Promise<unknown> {
    return this.invoke(deviceId, 'maker:resolve-interaction', [requestId, { kind: 'ask_user_question', answers }]);
  }

  resolvePlan(deviceId: string, requestId: string, approved: boolean, plan: string, feedback?: string): Promise<unknown> {
    const reason = feedback?.trim() || undefined;
    return this.invoke(deviceId, 'maker:resolve-interaction', [requestId, {
      kind: 'plan_review', behavior: approved ? 'allow' : 'deny',
      editedPlan: approved ? plan : undefined, reason: approved ? undefined : reason,
    }]);
  }

  // ── 媒体(经自建中转的媒体存储)与远程文件 ────────────────────────────────────
  private async relayJson<T>(path: string, body: unknown): Promise<T> {
    const res = await this.fetchFn(`${this.baseUrl}/api/device-link${path}`, {
      method: 'POST',
      headers: { Authorization: `CindyRelay ${this.credential}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new RemoteError(res.status === 401 ? 'UNAUTHORIZED' : 'FAILED', `media request failed (${res.status})`);
    return (await res.json()) as T;
  }

  /** 上传一个文件,返回可随消息发送的附件。 */
  async uploadAttachment(file: Blob & { name?: string }, name = file.name ?? 'file'): Promise<WebAttachment> {
    if (file.size <= 0) throw new RemoteError('EMPTY_FILE', 'file is empty');
    if (file.size > WEB_ATTACHMENT_MAX_BYTES) throw new RemoteError('FILE_TOO_LARGE', 'file is too large');
    const mimeType = file.type || 'application/octet-stream';
    const digest = await hashBlob(file);
    const { putUrl, key } = await this.relayJson<{ putUrl: string; key: string }>('/media/presign-put', {
      size: file.size, contentType: mimeType, ext: extOf(name) || 'bin',
    });
    const put = await this.fetchFn(putUrl, { method: 'PUT', headers: { 'Content-Type': mimeType }, body: file });
    if (!put.ok) throw new RemoteError('UPLOAD_FAILED', `upload failed (${put.status})`);
    return buildWebAttachment({ key, name, size: file.size, sha256: digest, mimeType });
  }

  async mediaDownloadUrl(key: string): Promise<string> {
    return (await this.relayJson<{ getUrl: string }>('/media/presign-get', { key })).getUrl;
  }

  fileOp<T>(deviceId: string, args: Record<string, unknown>): Promise<T> {
    return this.invoke(deviceId, 'file-browser:remote-op', [args]);
  }

  listDir(deviceId: string, workdir: string, relPath: string): Promise<RemoteDirEntry[]> {
    return this.fileOp(deviceId, { op: 'listDir', workdir, relPath });
  }

  readFile(deviceId: string, workdir: string, relPath: string): Promise<{ ok: true; data: { content: string; size: number; truncated?: boolean; contentEncoding?: string } } | { ok: false; code: string }> {
    return this.fileOp(deviceId, { op: 'readFile', workdir, relPath });
  }

  /** 下载电脑上的文件:电脑先上传到中转的媒体存储,完成后返回下载地址。 */
  async exportFile(deviceId: string, workdir: string, relPath: string, onProgress?: (uploaded: number, size: number) => void, signal?: AbortSignal): Promise<string> {
    const start = await this.fileOp<{ ok: boolean; transferId?: string; message?: string }>(deviceId, { op: 'exportFileStart', workdir, relPath, maxBytes: 2 * 1024 ** 3 });
    if (!start.ok || !start.transferId) throw new RemoteError('EXPORT_FAILED', start.message ?? 'export failed');
    for (;;) {
      if (signal?.aborted) throw new RemoteError('CANCELLED', 'cancelled');
      const status = await this.fileOp<{ ok: boolean; state?: string; key?: string; message?: string; size?: number; uploaded?: number }>(
        deviceId, { op: 'exportFileStatus', workdir, transferId: start.transferId });
      if (!status.ok || status.state === 'error') throw new RemoteError('EXPORT_FAILED', status.message ?? 'export failed');
      onProgress?.(status.uploaded ?? 0, status.size ?? 0);
      if (status.state === 'done' && status.key) return this.mediaDownloadUrl(status.key);
      await new Promise((resolve) => setTimeout(resolve, EXPORT_POLL_MS));
    }
  }

  // ── 任务管理与定时任务 ────────────────────────────────────────────────────
  /** 改名、归档(status: 'archived')、置顶;与手机同一个 channel。 */
  patchSession(deviceId: string, sessionId: string, patch: { title?: string; status?: 'active' | 'archived'; pinnedAt?: string | null }): Promise<RemoteSessionRow> {
    return this.invoke(deviceId, 'local-db:sessions:patch-meta', [sessionId, patch]);
  }

  listSchedules(deviceId: string): Promise<ScheduleRow[]> {
    return this.invoke(deviceId, 'maker:schedule:list', []);
  }

  createSchedule(deviceId: string, input: Record<string, unknown>): Promise<ScheduleRow> {
    return this.invoke(deviceId, 'maker:schedule:create', [input]);
  }

  scheduleAction(deviceId: string, action: 'run-now' | 'pause' | 'resume' | 'delete', id: string): Promise<unknown> {
    return this.invoke(deviceId, `maker:schedule:${action}`, [id]);
  }

  listScheduleRuns(deviceId: string, id: string, limit = 20): Promise<ScheduleRunRow[]> {
    return this.invoke(deviceId, 'maker:schedule:list-runs', [id, limit]);
  }

  /** 被控端转发来的 push 事件(`maker:event`、`local-db:messages:created` 等)。 */
  onPush(cb: (event: PushEvent) => void): () => void {
    return this.client.onFrame((env: Envelope) => {
      if (env.kind !== 'push' || !env.src) return;
      const payload = env.payload as { channel?: unknown; payload?: unknown } | undefined;
      if (typeof payload?.channel !== 'string') return;
      cb({ from: env.src, channel: payload.channel, payload: payload.payload });
    });
  }
}
