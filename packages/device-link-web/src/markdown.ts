/**
 * 把助手回复里的 Markdown 渲染成 DOM,只用 `createElement` / `textContent`,不经过 innerHTML:
 * 正文里的 HTML、脚本、`javascript:` 链接都只会显示成文字或被丢弃。
 * 支持:标题、段落、围栏代码块、行内代码、粗体 / 斜体、链接(仅 http / https / mailto)、有序 / 无序列表、引用、分隔线。
 * 不支持的写法(表格、图片、嵌套列表)按普通文字显示。
 */

function safeHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'mailto:' ? url.href : null;
  } catch {
    return null;
  }
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/;

function inline(parent: HTMLElement, text: string): void {
  let rest = text;
  while (rest) {
    const match = INLINE.exec(rest);
    if (!match) { parent.append(document.createTextNode(rest)); return; }
    if (match.index > 0) parent.append(document.createTextNode(rest.slice(0, match.index)));
    const token = match[0];
    if (match[1]) {
      const code = document.createElement('code');
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (match[2]) {
      const strong = document.createElement('strong');
      inline(strong, token.slice(2, -2));
      parent.append(strong);
    } else if (match[3]) {
      const em = document.createElement('em');
      inline(em, token.slice(1, -1));
      parent.append(em);
    } else {
      const parts = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token)!;
      const href = safeHref(parts[2]);
      if (href) {
        const a = document.createElement('a');
        a.href = href;
        a.rel = 'noopener noreferrer';
        a.target = '_blank';
        a.textContent = parts[1];
        parent.append(a);
      } else parent.append(document.createTextNode(parts[1]));
    }
    rest = rest.slice(match.index + token.length);
  }
}

export function renderMarkdown(source: string): DocumentFragment {
  const out = document.createDocumentFragment();
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const startsBlock = (line: string) => /^(#{1,6}\s|```|>\s?|[-*+]\s|\d+[.)]\s|(-{3,}|\*{3,})\s*$)/.test(line);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      code.textContent = body.join('\n');
      pre.append(code);
      out.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const h = document.createElement(`h${Math.min(6, heading[1].length + 2)}` as 'h3');
      inline(h, heading[2].trim());
      out.append(h);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.append(document.createElement('hr')); i++; continue; }
    if (/^>\s?/.test(line)) {
      const quote = document.createElement('blockquote');
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      inline(quote, body.join('\n'));
      out.append(quote);
      continue;
    }
    const list = /^([-*+]|\d+[.)])\s+/.exec(line);
    if (list) {
      const ordered = /\d/.test(list[1]);
      const el = document.createElement(ordered ? 'ol' : 'ul');
      while (i < lines.length && /^([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const item = document.createElement('li');
        inline(item, lines[i++].replace(/^([-*+]|\d+[.)])\s+/, ''));
        el.append(item);
      }
      out.append(el);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i]))) para.push(lines[i++]);
    const p = document.createElement('p');
    inline(p, para.join('\n'));
    out.append(p);
  }
  return out;
}
