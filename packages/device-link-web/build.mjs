// 把网页控制端打成三个静态文件 dist/{index.html,app.js,app.css},由自建中转在 /web/ 同源提供。
// 不使用内联脚本 / 样式:中转给页面的 CSP 只允许同源脚本与样式。
import * as esbuild from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const here = (path) => fileURLToPath(new URL(path, import.meta.url));
const normalizeEolPlugin = {
  name: 'normalize-eol-lf',
  setup(build) {
    build.onLoad({ filter: /\.(ts|js|mjs|cjs|json)$/ }, async (args) => {
      const raw = await readFile(args.path, 'utf8');
      const ext = args.path.slice(args.path.lastIndexOf('.') + 1);
      return { contents: raw.replace(/\r\n/g, '\n'), loader: ext === 'ts' ? 'ts' : ext === 'json' ? 'json' : 'js' };
    });
  },
};

await mkdir(here('dist'), { recursive: true });
await esbuild.build({
  entryPoints: [here('src/main.ts')],
  bundle: true,
  platform: 'browser',
  target: ['es2022', 'chrome100', 'safari15', 'firefox100'],
  format: 'esm',
  outfile: here('dist/app.js'),
  legalComments: 'none',
  minify: true,
  sourcemap: false,
  // 共享包按需引入;下面的 define 保证未用到的 Node 分支被裁掉。
  define: { 'process.env.NODE_ENV': '"production"' },
  plugins: [normalizeEolPlugin],
});
await copyFile(here('public/index.html'), here('dist/index.html'));
await copyFile(here('public/app.css'), here('dist/app.css'));
console.log('built dist/{index.html,app.js,app.css}');
