/**
 * 浏览器控制端的静态资源(`packages/device-link-web` 构建产物)。
 *
 * 中转在 `/web/` 下同源提供它:页面、WebSocket、REST 同一个来源,不需要 CORS,
 * 凭证也不会发给第三方来源。独立运行用的单文件 bundle 在构建时把产物内联进来
 * (`build.mjs` 注入 `__CINDY_WEB_CLIENT__`);在仓库里开发或测试时从 `device-link-web/dist` 读取。
 * 没有产物时返回 null,中转照常工作,只是不提供网页。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export interface WebAsset {
  type: string;
  body: Buffer;
}

export type WebAssets = ReadonlyMap<string, WebAsset>;

declare const __CINDY_WEB_CLIENT__: Record<string, { type: string; body: string }> | undefined;

export const WEB_CLIENT_FILES: Readonly<Record<string, string>> = {
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'app.css': 'text/css; charset=utf-8',
};

/** 页面只允许加载同源脚本与样式,不执行内联脚本;连接限同源(WebSocket 与 REST)。 */
export const WEB_CLIENT_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function loadBundledWebAssets(): WebAssets | null {
  const assets = new Map<string, WebAsset>();
  if (typeof __CINDY_WEB_CLIENT__ !== 'undefined') {
    for (const [name, asset] of Object.entries(__CINDY_WEB_CLIENT__)) {
      assets.set(name, { type: asset.type, body: Buffer.from(asset.body, 'utf8') });
    }
    return assets.has('index.html') ? assets : null;
  }
  try {
    const dist = fileURLToPath(new URL('../../device-link-web/dist/', import.meta.url));
    for (const [name, type] of Object.entries(WEB_CLIENT_FILES)) {
      assets.set(name, { type, body: readFileSync(dist + name) });
    }
    return assets;
  } catch {
    return null;
  }
}
