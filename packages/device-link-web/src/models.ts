/** 模型选择:从被控端的供应商列表里挑出能用于某个 Agent 的模型。纯函数,便于测试。 */
import type { AgentKindName, ProviderLike } from './remote';

export interface ModelOption {
  key: string;
  providerId: string;
  providerName: string;
  modelId: string;
  label: string;
  efforts: string[];
}

export const PERMISSION_MODES = ['ask', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'] as const;
export type PermissionModeName = (typeof PERMISSION_MODES)[number];

/** 会话行里的 agentKind 是 'cc' | 'codex' | 'pi',创建与模型目录用 'claude-code'。 */
export function agentKindOf(value: unknown): AgentKindName {
  return value === 'codex' || value === 'pi' ? value : 'claude-code';
}

export function modelKey(providerId: string | null | undefined, modelId: string): string {
  return `${providerId ?? ''}\u0000${modelId}`;
}

/** 只列已连接、未停用供应商里没被隐藏的模型;同一模型出现在多个来源时分别列出,让用户选来源。 */
export function modelOptions(providers: readonly ProviderLike[], agent: AgentKindName): ModelOption[] {
  const result: ModelOption[] = [];
  for (const provider of providers) {
    if (!provider.connected || provider.suspended || !provider.agents.includes(agent)) continue;
    for (const model of provider.models[agent] ?? []) {
      if (model.disabled) continue;
      result.push({
        key: modelKey(provider.id, model.id), providerId: provider.id, providerName: provider.name, modelId: model.id,
        label: model.name || model.id, efforts: Array.isArray(model.efforts) ? model.efforts : [],
      });
    }
  }
  return result;
}

/** 当前会话用的模型在列表里的位置:先按(来源,模型)精确匹配,来源未知时按模型 ID。 */
export function findModelOption(options: readonly ModelOption[], modelId: string, providerId?: string | null): ModelOption | undefined {
  return options.find((o) => o.modelId === modelId && (providerId ? o.providerId === providerId : true))
    ?? options.find((o) => o.modelId === modelId);
}

/** 从 Full access 以外的档位进入 Full access 必须显式确认(与桌面、手机一致)。 */
export function needsFullAccessConfirmation(current: string, next: string): boolean {
  return next === 'bypassPermissions' && current !== 'bypassPermissions';
}
