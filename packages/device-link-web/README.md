# @cindy/device-link-web

浏览器里的 Cindy 控制端：远程查看和控制自己的电脑，不需要 Cindy 账号。设计与边界见
[自建中转方案 §17](../../docs/self-hosted-relay-plan.md#17-浏览器控制端网页版2026-10-30)。

- 只连**自建中转**（`packages/device-link-relay`）：页面由中转在 `/web/` 同源提供，`relay serve --no-web` 可关闭。
- 加入：主人电脑生成加入链接，粘贴到网页，主人在电脑上同意；之后用只对这个中转有效的凭证连接，
  并用设备签名（与手机同一套）保护每条消息。
- 面向桌面浏览器（宽屏、键盘鼠标）。能力：任务（查看、发送、停止、审批）与**远程桌面**（整个屏幕的查看与操作）。
- 纯控制端：能力边界就是 `REMOTE_INVOKE_ALLOWLIST` 与远程桌面通道，不比手机多。

## 开发

```bash
pnpm --filter @cindy/device-link-web run build      # 生成 dist/{index.html,app.js,app.css}
pnpm --filter @cindy/device-link-web run typecheck
pnpm --filter @cindy/device-link-web run test
pnpm --filter @cindy/device-link-relay run bundle   # 先构建网页，再把它内联进 dist/relay.mjs
```

在仓库里运行未打包的中转时，中转从 `packages/device-link-web/dist` 读取页面；没有构建产物时只是不提供网页。

## 约束

- 页面不执行内联脚本，文字一律以 `textContent` 写入，不使用 `innerHTML`。
- 颜色走 `app.css` 顶部的语义变量，Light / Dark 各一套。
- 不使用 `crypto.subtle`（http 的局域网页面也要能用），签名用 `@noble`。
