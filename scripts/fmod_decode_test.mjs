// 临时脚本4：Node 内用项目 FMOD WASM 解码（stub AudioContext + NOSOUND 输出）
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require2 = createRequire(import.meta.url);

// ---- stub 浏览器音频环境（FMOD glue 里会 new AudioContext；解码用 NOSOUND 输出，不需要真出声）
class FakeParam { constructor() { this.value = 0; } setValueAtTime() {} linearRampToValueAtTime() {} }
class FakeNode {
  constructor() { this.gain = new FakeParam(); this.frequency = new FakeParam(); this.Q = new FakeParam(); this.channelCount = 2; }
  connect() { return this; } disconnect() {} start() {} stop() {} addEventListener() {}
}
class FakeAudioContext {
  constructor() {
    this.state = 'running';
    this.sampleRate = 48000;
    this.currentTime = 0;
    this.destination = { channelCount: 2, maxChannelCount: 2 };
    this.listener = {};
  }
  createGain() { return new FakeNode(); }
  createScriptProcessor() { return new FakeNode(); }
  createBufferSource() { return new FakeNode(); }
  createDynamicsCompressor() { return new FakeNode(); }
  createAnalyser() { return new FakeNode(); }
  createBuffer() { return { getChannelData: () => new Float32Array(0), length: 0, numberOfChannels: 2, sampleRate: 48000 }; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
}
globalThis.AudioContext = FakeAudioContext;
globalThis.webkitAudioContext = FakeAudioContext;
if (!globalThis.self) globalThis.self = globalThis;
globalThis.window = globalThis;

const loadBrowser = require2('@arkntools/fmod/browser.js');
const SYMBOL = { OUTVAR: Symbol('o'), DISMISS: Symbol('d') };
const wrap = (M) =>
  new Proxy(M, {
    get(t, p) {
      if (p in t || typeof p !== 'string' || !p.startsWith('$')) return t[p];
      p = p.substring(1);
      if (typeof t[p] !== 'function') return t[p];
      return (...args) => {
        const outs = [];
        const ua = args.map((a) => {
          if (a === SYMBOL.OUTVAR) { const o = {}; outs.push(o); return o; }
          if (a === SYMBOL.DISMISS) return {};
          return a;
        });
        const r = t[p](...ua);
        if (r !== 0) { const err = new Error(`FMOD ${p} failed=${r}`); err.code = r; throw err; }
        return outs.length > 1 ? outs.map((o) => o.val) : outs[0]?.val;
      };
    },
  });

const Module = await loadBrowser();
Module.window = globalThis;
const FMOD = wrap(Module);

// 列出输出类型常量，选 NOSOUND
const outs = Object.keys(FMOD).filter((k) => k.startsWith('OUTPUTTYPE_'));
console.log('可用输出类型:', outs.join(', '));

const systemRaw = FMOD.$System_Create(SYMBOL.OUTVAR);
const system = wrap(systemRaw);
if (FMOD.OUTPUTTYPE_NOSOUND != null) {
  systemRaw.setOutput(FMOD.OUTPUTTYPE_NOSOUND);
  console.log('已选择 OUTPUTTYPE_NOSOUND');
}
try {
  systemRaw.init(32, FMOD.INIT_NORMAL, 0);
  console.log('system init 成功');
} catch (e) {
  console.log('system init 失败:', e.message);
  process.exit(1);
}

const readFsbSlice = (path) => {
  const b = fs.readFileSync(path);
  const fo = b.indexOf(Buffer.from('FSB5'));
  const u8 = new Uint8Array(b.buffer, b.byteOffset + fo, b.length - fo);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  return { u8, ns: dv.getUint32(8, true) };
};

const decodeOne = (u8, index) => {
  const exinfo = FMOD.CREATESOUNDEXINFO();
  exinfo.length = u8.length;
  const sound = wrap(system.$createSound(u8, FMOD.OPENMEMORY, exinfo, SYMBOL.OUTVAR));
  const sub = wrap(sound.$getSubSound(index, SYMBOL.OUTVAR));
  try {
    const [, channels] = sub.$getFormat(SYMBOL.DISMISS, SYMBOL.OUTVAR, SYMBOL.OUTVAR, SYMBOL.OUTVAR);
    const rate = Math.floor(sub.$getDefaults(SYMBOL.OUTVAR, SYMBOL.DISMISS));
    const len = sub.$getLength(SYMBOL.OUTVAR, FMOD.TIMEUNIT_PCMBYTES);
    const [p1, , l1] = sub.$lock(0, len, SYMBOL.OUTVAR, SYMBOL.OUTVAR, SYMBOL.OUTVAR, SYMBOL.OUTVAR);
    try {
      const heap = FMOD.HEAPU8;
      let sum = 0, peak = 0;
      const dv = new DataView(heap.buffer, heap.byteOffset + p1, l1);
      const n = Math.floor(l1 / 2);
      for (let i = 0; i < n; i++) {
        const v = Math.abs(dv.getInt16(i * 2, true));
        sum += v;
        if (v > peak) peak = v;
      }
      return { channels, rate, len, frames: n / (channels || 1), avg: n ? sum / n : 0, peak };
    } finally {
      sub.$unlock(p1, 0, l1, 0);
    }
  } finally {
    sub.release();
    sound.release();
  }
};

const files = [
  ['原始', 'C:/Users/34072/Desktop/BankStudioWeb/比对2/比对/bgm_title0.bank'],
  ['我们', 'C:/Users/34072/Desktop/BankStudioWeb/比对2/bgm_title0.repack (2).bank'],
  ['有效', 'C:/Users/34072/Desktop/BankStudioWeb/比对2/有效工具导入导出后.bank'],
  ['修补对齐版', 'C:/Users/34072/Desktop/BankStudioWeb/比对2/bgm_title0.repack (2).aligned.bank'],
];

for (const [tag, p] of files) {
  const { u8, ns } = readFsbSlice(p);
  console.log(`\n===== ${tag} (${ns} 样本) =====`);
  for (let i = 0; i < ns; i++) {
    try {
      const r = decodeOne(u8, i);
      console.log(`  #${i} ✔ ch=${r.channels} ${r.rate}Hz ${r.frames}帧 平均幅值=${r.avg.toFixed(1)} 峰值=${r.peak}`);
    } catch (e) {
      console.log(`  #${i} ✘ ${e.message}`);
    }
  }
}
process.exit(0);
