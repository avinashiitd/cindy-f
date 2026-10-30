// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口:助手回复的 Markdown 渲染(`renderMarkdown`)和新建任务 / 切换模型用的模型选项(`modelOptions`)。
 * - 规则依据:正文来自被控端的 Agent 输出,可能含 HTML、脚本、`javascript:` 链接,必须只显示成文字;
 *   模型下拉只能列已连接、未停用、未隐藏的模型,且同一模型来自多个来源时要能区分来源;进入 Full access 必须确认。
 * - 现有覆盖缺口:端到端用例不渲染界面;没有任何用例检查 Markdown 的安全边界。
 * - 最小失败输入:`<img onerror>`、`[x](javascript:alert(1))`、停用的供应商、同一模型两个来源。
 * - tier:unit(jsdom,无网络)。
 */
import { describe, expect, it } from 'vitest';

import { renderMarkdown } from '../markdown';
import { agentKindOf, findModelOption, modelOptions, needsFullAccessConfirmation } from '../models';
import type { ProviderLike } from '../remote';

function render(source: string): HTMLElement {
  const host = document.createElement('div');
  host.append(renderMarkdown(source));
  return host;
}

describe('markdown rendering', () => {
  it('never interprets HTML or unsafe links from agent output', () => {
    const host = render('<img src=x onerror=alert(1)> <script>boom()</script>\n\n[bad](javascript:alert(1)) and [ok](https://example.com/a?b=1)');
    expect(host.querySelector('img, script')).toBeNull();
    expect(host.textContent).toContain('<script>boom()</script>');
    const links = [...host.querySelectorAll('a')];
    expect(links.map((a) => a.getAttribute('href'))).toEqual(['https://example.com/a?b=1']);
    expect(links[0].rel).toContain('noopener');
    expect(host.textContent).toContain('bad');
  });

  it('renders the common structure: headings, fenced code, lists, emphasis, quotes', () => {
    const host = render('# Title\n\nSome **bold** and `code`.\n\n- a\n- b\n\n1. one\n2. two\n\n```ts\nconst x = "<b>";\n```\n\n> quoted');
    expect(host.querySelector('h3')?.textContent).toBe('Title');
    expect(host.querySelector('strong')?.textContent).toBe('bold');
    expect([...host.querySelectorAll('ul > li')].map((l) => l.textContent)).toEqual(['a', 'b']);
    expect(host.querySelector('ol')?.children).toHaveLength(2);
    expect(host.querySelector('pre code')?.textContent).toBe('const x = "<b>";');
    expect(host.querySelector('b')).toBeNull();
    expect(host.querySelector('blockquote')?.textContent).toBe('quoted');
  });
});

describe('model options', () => {
  const model = (id: string, extra = {}) => ({ id, name: id.toUpperCase(), ...extra });
  const providers: ProviderLike[] = [
    { id: 'anthropic', name: 'Anthropic', agents: ['claude-code'], connected: true, models: { 'claude-code': [model('opus', { efforts: ['low', 'high'] }), model('hidden', { disabled: true })] } },
    { id: 'gateway', name: 'Gateway', agents: ['claude-code', 'codex'], connected: true, models: { 'claude-code': [model('opus')], codex: [model('gpt')] } },
    { id: 'off', name: 'Off', agents: ['claude-code'], connected: false, models: { 'claude-code': [model('nope')] } },
    { id: 'paused', name: 'Paused', agents: ['claude-code'], connected: true, suspended: true, models: { 'claude-code': [model('nope2')] } },
  ];

  it('lists only usable models per agent and keeps the provider that serves a duplicate model', () => {
    const claude = modelOptions(providers, 'claude-code');
    expect(claude.map((o) => `${o.providerId}/${o.modelId}`)).toEqual(['anthropic/opus', 'gateway/opus']);
    expect(modelOptions(providers, 'codex').map((o) => o.modelId)).toEqual(['gpt']);
    expect(findModelOption(claude, 'opus', 'gateway')?.providerId).toBe('gateway');
    expect(findModelOption(claude, 'opus', null)?.providerId).toBe('anthropic');
    expect(claude[0].efforts).toEqual(['low', 'high']);
  });

  it('maps the stored agent kind and asks before entering Full access only', () => {
    expect([agentKindOf('cc'), agentKindOf('codex'), agentKindOf('pi'), agentKindOf(undefined)]).toEqual(['claude-code', 'codex', 'pi', 'claude-code']);
    expect(needsFullAccessConfirmation('ask', 'bypassPermissions')).toBe(true);
    expect(needsFullAccessConfirmation('bypassPermissions', 'bypassPermissions')).toBe(false);
    expect(needsFullAccessConfirmation('ask', 'plan')).toBe(false);
  });
});
