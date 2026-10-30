/** 极小的 DOM 构造助手。所有文字走 textContent / 属性,不使用 innerHTML,消息正文不会被当成 HTML。 */
type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') el.className = String(value);
    else if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2).toLowerCase(), value as EventListener);
    } else if (value === true) el.setAttribute(name, '');
    else el.setAttribute(name, String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

export function replaceChildren(parent: Element, ...children: Child[]): void {
  parent.replaceChildren(...children.filter((c): c is Node | string => !!c));
}
