/// <reference types="vitest" />
import { fileURLToPath, URL } from 'node:url';
import { resolve } from 'node:path';
import Vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // 单文件模式：vite build --mode single（跨平台，Windows 下也能用）
  const single = mode === 'single';
  return {
  // 部署到 GitHub Pages 子路径时由 VITE_BASE 注入
  base: process.env.VITE_BASE ?? '/',
  server: {
    port: 8080,
  },
  build: {
    chunkSizeWarningLimit: 5000,
    // 单文件模式下禁用代码分割，把动态 import（libvorbis）并入主包
    ...(single
      ? { rollupOptions: { output: { codeSplitting: false } } }
      : {}),
  },
  plugins: [
    Vue(),
    // 单文件模式把全部 JS / CSS / 动态 chunk 内联进一个 index.html，
    // 产出可直接双击打开的单一 HTML 文件。
    ...(single
      ? [
          viteSingleFile({
            // 省略 inlinePattern：默认空数组会内联所有 JS / CSS 产物
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // node-web-audio-api 是 FMOD 桌面端音频后端的原生模块，浏览器/Web 端不会执行该路径
      // （浏览器音频走 Web Audio）。构建时指向空模块，避免打包 node 专属依赖导致解析失败。
      'node-web-audio-api': resolve(__dirname, 'src/empty-module.ts'),
    },
  },
  optimizeDeps: {
    // 不能排除 @arkntools/fmod：它是 CJS 模块（browser.js 用 module.exports 导出），
    // 若排除会让 Vite 原样透传 CJS 文件到浏览器，ESM 的 `import FMOD from ...` 会报
    // "does not provide an export named 'default'"。必须交给 Vite 预构建做 CJS 互操作。
    exclude: [],
  },
  };
});