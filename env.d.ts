/// <reference types="vite/client" />

declare module 'vite/client' {
  interface ImportMetaEnv {
    readonly VITE_BASE?: string;
  }
}

declare module 'element-plus/dist/locale/zh-cn.mjs' {
  const locale: any;
  export default locale;
}

// vorbis-encoder-js 打包产物（emberc 单文件 asm.js，API 见 utils/vorbisEncoder.ts 的 LibVorbisModule）
declare module 'vorbis-encoder-js/dist/libvorbis.js' {
  const mod: Record<string, unknown>;
  export default mod;
}