<script setup lang="ts">
import { computed, reactive, ref, watch, nextTick, onUnmounted, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  Loading,
  Headset,
  VideoPlay,
  VideoPause,
  Download,
  Refresh,
  Upload,
  FolderOpened,
  Search,
  Back,
  Check,
  Moon,
  Sunny,
  MagicStick,
  Document,
  InfoFilled,
  Warning,
  CircleCheck,
  Files,
  DataLine,
  ArrowLeftBold,
  ArrowRightBold,
  Bottom,
  Close,
} from '@element-plus/icons-vue';
import { parseFsbBank, detectFsbBank, type FsbSampleMeta } from '@/utils/fsbParser';
import { decodeFsbSubSound } from '@/utils/fsbDecode';
import { decodeAudioFileToPcm, pcmToWavBlob, resamplePcm16 } from '@/utils/audioDecode';
import {
  FSB5_MODE_PCM16,
  FSB5_MODE_VORBIS,
  writeFsb5,
  wrapFsbInContainer,
  extractFsbSamplePcm,
  wavToPcm16,
  type FsbWriteSample,
} from '@/utils/fsbWriter';
import { repackFsb5Incremental, selfCheckRepacked, parseFsb5Raw } from '@/utils/fsbRepack';
import { CHAR_BANKS, type CharBankLookup } from '@/data/charBanks';
import {
  putRecent,
  listRecent,
  removeRecent,
  clearRecent,
  putSession,
  getSession,
  clearSession,
  type RecentBank,
  type Session,
  type PersistedReplace,
} from '@/utils/storage';

/** extra chunk 类型 → 中文名（详情抽屉用） */
const CHUNK_NAMES: Record<number, string> = {
  1: '声道数',
  2: '采样率',
  3: '循环',
  11: 'Vorbis 数据',
  13: '峰值音量',
};
const hex8 = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
const WAVE_ORIG_COLOR = '#4f7cff';
const WAVE_REP_COLOR = '#34d399';

/** 一条替换记录（A 保真替换用：同时保留原生 PCM 以便切换开关时重算） */
interface ReplacedEntry {
  /** 原始解码出的原生 PCM16 */
  nativePcm: Int16Array;
  nativeChannels: number;
  nativeRate: number;
  /** 最终用于替换/试听/重打包的 PCM（匹配原格式时已被重采样） */
  pcm: Int16Array;
  channels: number;
  sampleRate: number;
  /** 匹配原格式且发生格式变化时记录 */
  converted?: { fromCh: number; toCh: number; fromRate: number; toRate: number };
  /** 是否保留了原生格式（关闭「匹配原格式」时） */
  native?: boolean;
}

const CODEC_NAMES: Record<number, string> = {
  0: 'PCM',
  1: 'PCM',
  2: 'ADPCM',
  3: 'MP3',
  4: 'PSMVAG',
  5: 'HEVAG',
  6: 'XMA',
  7: 'AAC',
  8: 'GCADPCM',
  9: 'ATRAC9',
  15: 'Vorbis',
};

// ---------------------------------------------------------------- 主题

type AccentKey = 'blue' | 'cyan' | 'green' | 'violet' | 'amber' | 'rose';

const ACCENTS: { key: AccentKey; label: string; color: string }[] = [
  { key: 'blue', label: '蓝', color: '#4f7cff' },
  { key: 'cyan', label: '青', color: '#22d3ee' },
  { key: 'green', label: '绿', color: '#34d399' },
  { key: 'violet', label: '紫', color: '#8b5cf6' },
  { key: 'amber', label: '琥珀', color: '#f59e0b' },
  { key: 'rose', label: '玫红', color: '#fb7185' },
];

const accentKey = ref<AccentKey>((localStorage.getItem('bs-accent') as AccentKey) || 'rose');
const isDark = ref(localStorage.getItem('bs-dark') !== 'light');
const themePop = ref(false);

watch(accentKey, (v) => {
  document.documentElement.setAttribute('data-accent', v);
  localStorage.setItem('bs-accent', v);
});
watch(isDark, (v) => {
  document.documentElement.setAttribute('data-theme', v ? 'dark' : 'light');
  localStorage.setItem('bs-dark', v ? 'dark' : 'light');
});
onMounted(() => {
  document.documentElement.setAttribute('data-accent', accentKey.value);
  document.documentElement.setAttribute('data-theme', isDark.value ? 'dark' : 'light');
  // 读取最近文件 + 检测可恢复会话
  listRecent().then((list) => (recentList.value = list)).catch((e) => console.warn('[BankStudio] 读取最近文件失败', e));
  getSession()
    .then((sess) => {
      if (sess && sess.replaces.length > 0) restoreRaw.value = sess;
    })
    .catch((e) => console.warn('[BankStudio] 读取会话失败', e));
  // 键盘快捷键
  window.addEventListener('keydown', onKeydown);
});

// ---------------------------------------------------------------- 键盘快捷键

const onKeydown = (e: KeyboardEvent) => {
  // 输入框内不拦截
  const tag = (e.target as HTMLElement)?.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return;

  // 聚焦搜索框：'/'
  if (e.key === '/' && hasContent.value) {
    e.preventDefault();
    (document.querySelector<HTMLInputElement>('.search input'))?.focus();
    return;
  }
  // 播放/暂停：空格
  if (e.code === 'Space' && currentIndex.value >= 0) {
    e.preventDefault();
    toggle(currentIndex.value);
    return;
  }
  // 上一首：←
  if (e.key === 'ArrowLeft' && currentIndex.value >= 0) {
    e.preventDefault();
    prevSample();
    return;
  }
  // 下一首：→
  if (e.key === 'ArrowRight' && currentIndex.value >= 0) {
    e.preventDefault();
    nextSample();
    return;
  }
  // 关闭播放条：Esc
  if (e.key === 'Escape' && currentIndex.value >= 0) {
    closePlayer();
  }
};

// ---------------------------------------------------------------- 最近文件 / 会话恢复

const openRecent = async (r: RecentBank) => {
  await loadBuf(r.name, r.bytes);
};

const delRecent = async (name: string) => {
  try {
    await removeRecent(name);
    recentList.value = recentList.value.filter((r) => r.name !== name);
  } catch (e) {
    console.warn('[BankStudio] 删除最近文件失败', e);
  }
};

/** 恢复上次会话：载入源 bank 后逐个重放替换（用 matchOriginal 重算最终 PCM） */
const doRestore = async () => {
  const sess = restoreRaw.value;
  if (!sess) return;
  restoring.value = true;
  try {
    matchOriginal.value = sess.matchOriginal;
    if (sess.matchLoudness !== undefined) matchLoudness.value = sess.matchLoudness;
    await loadBuf(sess.fileName, sess.bytes, true);
    for (const r of sess.replaces) {
      await applyReplacement(r.index, {
        pcm: r.nativePcm,
        channels: r.nativeChannels,
        sampleRate: r.nativeRate,
      });
    }
    restoreRaw.value = null;
    ElMessage.success(`已恢复上次会话（${sess.replaces.length} 个替换）`);
  } catch (e) {
    console.error('[BankStudio] 恢复会话失败', e);
    ElMessage.error(`恢复会话失败：${e}`);
  } finally {
    restoring.value = false;
  }
};

/** 丢弃上次未完成的会话（清除持久化数据并关闭提示卡） */
const discardRestore = async () => {
  try {
    await clearSession();
  } catch (e) {
    console.warn('[BankStudio] 清除会话失败', e);
  }
  restoreRaw.value = null;
  ElMessage.info('已丢弃上次会话');
};

const fmtRecentTime = (t: number) => {
  const d = new Date(t);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (sameDay) return hm;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
};

const clearAllRecent = async () => {
  try {
    await clearRecent();
    recentList.value = [];
  } catch (e) {
    console.warn('[BankStudio] 清空最近文件失败', e);
  }
};

// ---------------------------------------------------------------- 状态

const fileName = ref('');
const originalBytes = ref<Uint8Array | null>(null);
const fsbBytes = ref<Uint8Array | null>(null);
const fsbOffset = ref(0);
const bankMode = ref(0);
const samples = ref<FsbSampleMeta[]>([]);
const replaced = reactive<Record<number, ReplacedEntry>>({});

const urls = reactive<Record<number, string>>({});
const loading = reactive<Record<number, boolean>>({});
const playing = reactive<Record<number, boolean>>({});
const audioEls = reactive<Record<number, HTMLAudioElement | null>>({});
// 统一播放条状态
const currentIndex = ref(-1);
const currentName = ref('');
const curTime = ref(0);
const curDur = ref(0);
const fileInput = ref<HTMLInputElement | null>(null);
const replaceInput = ref<HTMLInputElement | null>(null);
const replacingIndex = ref<number>(-1);
const dragOverIndex = ref(-1);
const exporting = ref(false);
const exportMethod = ref<'incremental' | 'pcm16'>('incremental');
const exportStatus = ref('');
const exportProgress = ref(0);
// 批量替换进度
const batching = ref(false);
const batchStatus = ref('');
const batchProgress = ref(0);

// 搜索
const search = ref('');
const searchFocus = ref(false);

// 高级筛选
const filterCodec = ref<number | ''>('');
const filterChannels = ref<number | ''>('');
const filterReplaced = ref<'all' | 'replaced' | 'original'>('all');
const codecOptions = computed(() => {
  const set = new Set<number>();
  samples.value.forEach((s) => set.add(s.mode));
  return Array.from(set).sort((a, b) => a - b).map((m) => ({ value: m, label: codecName(m) }));
});

const replacedCount = computed(() => Object.keys(replaced).length);
const isReplaced = (i: number) => replaced[i] !== undefined;
const hasContent = computed(() => samples.value.length > 0);
const hasActiveFilter = computed(() => filterCodec.value !== '' || filterChannels.value !== '' || filterReplaced.value !== 'all');
const clearFilters = () => {
  filterCodec.value = '';
  filterChannels.value = '';
  filterReplaced.value = 'all';
};

// 最近文件 + 会话恢复
const recentList = ref<RecentBank[]>([]);
const restoreRaw = ref<Session | null>(null);
const restoring = ref(false);

const isVorbis = computed(() => bankMode.value === FSB5_MODE_VORBIS);
const exportMethods = computed(() => {
  const list: { value: 'incremental' | 'pcm16'; label: string }[] = [];
  if (isVorbis.value || bankMode.value === FSB5_MODE_PCM16) {
    list.push({
      value: 'incremental',
      label: isVorbis.value ? '增量重打包 (Vorbis)' : '增量重打包 (PCM16 无损)',
    });
  }
  list.push({ value: 'pcm16', label: '全量转 PCM16' });
  return list;
});

const filteredSamples = computed(() => {
  const q = search.value.trim().toLowerCase();
  return samples.value
    .map((s, i) => ({ s, i }))
    .filter(({ s, i }) => {
      // 名称搜索
      if (q && !s.name.toLowerCase().includes(q)) return false;
      // 编码格式
      if (filterCodec.value !== '' && s.mode !== filterCodec.value) return false;
      // 声道
      if (filterChannels.value !== '' && s.channels !== filterChannels.value) return false;
      // 替换状态
      if (filterReplaced.value === 'replaced' && !isReplaced(i)) return false;
      if (filterReplaced.value === 'original' && isReplaced(i)) return false;
      return true;
    });
});

// 大批量样本分页渲染：避免一次性渲染过多 DOM 导致卡顿
const PAGE_SIZE = 80;
const visibleCount = ref(PAGE_SIZE);
const pagedSamples = computed(() => filteredSamples.value.slice(0, visibleCount.value));
const hasMore = computed(() => visibleCount.value < filteredSamples.value.length);
const loadMore = () => {
  visibleCount.value += PAGE_SIZE;
};
// 筛选/搜索条件变化时重置分页
watch([search, filterCodec, filterChannels, filterReplaced], () => {
  visibleCount.value = PAGE_SIZE;
});

// ---------------------------------------------------------------- 新增功能状态

// A 替换保真：默认匹配原样本的声道/采样率（重采样），关闭则保留替换音原生格式
const matchOriginal = ref(true);
// 替换响度：默认把替换音音量归一化到原样本水平，避免忽大忽小
const matchLoudness = ref(true);

// C 批量替换：隐藏的多文件 / 文件夹输入
const batchInput = ref<HTMLInputElement | null>(null);

// H 样本详情抽屉 + E 波形/A·B 对比
const rawBank = ref<ReturnType<typeof parseFsb5Raw> | null>(null);
const detailOpen = ref(false);
const detailIndex = ref(-1);
const detailOrigCanvas = ref<HTMLCanvasElement | null>(null);
const detailRepCanvas = ref<HTMLCanvasElement | null>(null);
const wavePcm = reactive<Record<number, { pcm: Int16Array; channels: number } | null>>({});
const waveLoading = reactive<Record<number, boolean>>({});
const origUrls = reactive<Record<number, string>>({});

// G 导出自检报告
const selfCheck = ref<{ ok: boolean; sampleCount: number; messages: string[] } | null>(null);

// B 反向角色查询：当前 bank 归属的角色
const reverseDialog = ref(false);
const reverseResults = computed<CharBankLookup[]>(() => {
  const base = fileName.value.split(/[\\/]/).pop()?.toLowerCase() ?? '';
  if (!base) return [];
  return CHAR_BANKS.filter((e) => e.banks.some((b) => b.toLowerCase() === base)).slice(0, 200);
});
const openReverseDialog = () => {
  reverseDialog.value = true;
};

const detailMeta = computed(() =>
  detailIndex.value >= 0 && rawBank.value ? rawBank.value.samples[detailIndex.value] ?? null : null,
);

// ---------------------------------------------------------------- 角色 ↔ 音频库 对照查询

const charDialog = ref(false);
const charQuery = ref('');
const charResults = computed<CharBankLookup[]>(() => {
  const q = charQuery.value.trim().toLowerCase();
  if (!q) return [];
  return CHAR_BANKS.filter((e) => e.name.toLowerCase().includes(q)).slice(0, 200);
});
const openCharDialog = () => {
  charQuery.value = '';
  charDialog.value = true;
};
const copyBank = async (bank: string) => {
  try {
    await navigator.clipboard.writeText(bank);
    ElMessage.success(`已复制 ${bank}`);
  } catch {
    ElMessage.warning('复制失败，请手动复制');
  }
};

const codecName = (mode: number) => CODEC_NAMES[mode] ?? `mode ${mode}`;
const formatDuration = (sec: number) => {
  if (!sec || sec <= 0) return '0:00';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
};
/** 已替换样本的新时长（秒）：由替换后 PCM 帧数推算 */
const replacedDuration = (i: number): number => {
  const r = replaced[i];
  if (!r) return 0;
  return r.pcm.length / Math.max(1, r.sampleRate * r.channels);
};
/** 计算一条交错 PCM 的 RMS 音量（0..32767），用于响度匹配 */
const computeRms = (pcm: Int16Array): number => {
  if (!pcm || pcm.length === 0) return 0;
  let sum = 0;
  for (let k = 0; k < pcm.length; k++) {
    const v = pcm[k];
    sum += v * v;
  }
  return Math.sqrt(sum / pcm.length);
};
/** 按增益倍率缩放一条交错 PCM（就地），返回新数组 */
const scalePcm = (pcm: Int16Array, gain: number): Int16Array => {
  if (gain === 1 || gain <= 0) return pcm;
  const out = new Int16Array(pcm.length);
  for (let k = 0; k < pcm.length; k++) {
    let v = Math.round(pcm[k] * gain);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    out[k] = v;
  }
  return out;
};
const formatBytes = (n: number) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
};

const isPlaying = (i: number) => playing[i] === true;
const onPlay = (i: number) => (playing[i] = true);
const onPause = (i: number) => (playing[i] = false);

// ---------------------------------------------------------------- 载入

/** 把原始 bank 字节写入「当前会话」并持久化（供刷新恢复） */
const saveSession = async () => {
  if (!originalBytes.value || samples.value.length === 0) return;
  const replaces: PersistedReplace[] = Object.entries(replaced).map(([k, v]) => ({
    index: Number(k),
    nativePcm: v.nativePcm,
    nativeChannels: v.nativeChannels,
    nativeRate: v.nativeRate,
  }));
  try {
    await putSession({
      id: 'current',
      fileName: fileName.value,
      bytes: originalBytes.value,
      matchOriginal: matchOriginal.value,
      matchLoudness: matchLoudness.value,
      replaces,
      time: Date.now(),
    });
  } catch (e) {
    console.warn('[BankStudio] 会话持久化失败', e);
  }
};

const loadBuf = async (name: string, buf: Uint8Array, silent = false) => {
  try {
    const offset = detectFsbBank(buf, name);
    if (offset === null) {
      ElMessage.error(`「${name}」里没找到 FSB5 数据`);
      return;
    }
    const parsed = parseFsbBank(buf, offset);
    if (!parsed) {
      ElMessage.error('FSB5 解析失败');
      return;
    }
    // 清理旧状态
    Object.values(urls).forEach((u) => u && URL.revokeObjectURL(u));
    for (const k of Object.keys(urls)) delete urls[Number(k)];
    for (const k of Object.keys(loading)) delete loading[Number(k)];
    for (const k of Object.keys(playing)) delete playing[Number(k)];
    for (const k of Object.keys(replaced)) delete replaced[Number(k)];
    for (const k of Object.keys(audioEls)) delete audioEls[Number(k)];
    for (const k of Object.keys(origUrls)) {
      const u = origUrls[Number(k)];
      if (u) URL.revokeObjectURL(u);
      delete origUrls[Number(k)];
    }
    for (const k of Object.keys(wavePcm)) delete wavePcm[Number(k)];
    detailOpen.value = false;
    detailIndex.value = -1;
    selfCheck.value = null;
    search.value = '';
    currentIndex.value = -1;
    currentName.value = '';
    curTime.value = 0;
    curDur.value = 0;

    fileName.value = name;
    originalBytes.value = buf;
    fsbBytes.value = parsed.fsbBytes;
    fsbOffset.value = parsed.fsbOffset;
    bankMode.value = parsed.samples[0]?.mode ?? 0;
    samples.value = parsed.samples;
    rawBank.value = parseFsb5Raw(parsed.fsbBytes);
    exportMethod.value = isVorbis.value ? 'incremental' : 'pcm16';
    if (!silent) {
      ElMessage.success(`已载入 ${name}（${samples.value.length} 个子音频 · ${codecName(bankMode.value)}）`);
    }
    // 持久化：最近文件 + 当前会话
    putRecent(name, buf);
    saveSession();
  } catch (e) {
    console.error('[BankStudio] 载入失败', e);
    ElMessage.error(`载入失败：${e}`);
  }
};

const loadFile = async (file: File) => {
  const buf = new Uint8Array(await file.arrayBuffer());
  await loadBuf(file.name, buf);
};

const onPickFile = () => fileInput.value?.click();
const onFileChosen = async (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = '';
  if (file) await loadFile(file);
};

// 全局拖放
const onDrop = async (e: DragEvent) => {
  e.preventDefault();
  dragOverIndex.value = -1;
  const file = e.dataTransfer?.files?.[0];
  if (file) await loadFile(file);
};

// ---------------------------------------------------------------- 播放

const toggle = async (i: number, fromPlayer = false) => {
  const el = audioEls[i];
  if (el && !el.paused && currentIndex.value === i) {
    el.pause();
    return;
  }
  // 同时只允许播一个：开始播放前暂停其它所有音频
  for (const k of Object.keys(audioEls)) {
    const other = audioEls[Number(k)];
    if (Number(k) !== i && other && !other.paused) {
      other.pause();
    }
  }
  // 更新播放条
  currentIndex.value = i;
  currentName.value = samples.value[i]?.name ?? '';
  curTime.value = 0;
  curDur.value = 0;
  if (!urls[i]) {
    loading[i] = true;
    try {
      const fsb = fsbBytes.value!;
      const meta = samples.value[i];
      const wav = await decodeFsbSubSound(fsb, fsb.length, meta.channels, meta.index, meta.frequency);
      // Uint8Array → Blob URL
      const blob = new Blob([wav as unknown as BlobPart], { type: 'audio/wav' });
      urls[i] = URL.createObjectURL(blob);
      await nextTick(); // 等待 <audio> 渲染并绑定 ref，再播放
    } catch (err) {
      console.error('[BankStudio] 解码失败', err);
      ElMessage.error(`解码 #${i} 失败：${(err as Error).message}`);
    } finally {
      loading[i] = false;
    }
  }
  const after = audioEls[i];
  if (after && urls[i]) {
    try {
      await after.play();
    } catch (err) {
      console.error('[BankStudio] 播放失败', err);
    }
  } else if (fromPlayer) {
    // 播放条上一首/下一首时若没能切到有效音频，回退到播放条关闭
    currentIndex.value = -1;
  }
};

// ---- 统一播放条逻辑 ----
const onMeta = (i: number, e: Event) => {
  if (i !== currentIndex.value) return;
  const d = (e.target as HTMLAudioElement)?.duration || 0;
  if (isFinite(d) && d > 0) curDur.value = d;
};
const onTime = (i: number, e: Event) => {
  if (i !== currentIndex.value) return;
  curTime.value = (e.target as HTMLAudioElement)?.currentTime ?? 0;
};
const onEndedInner = (i: number) => {
  onPause(i);
  // 播放结束即停止，不自动连播下一首（用户可手动点播放条「下一首」）
  if (i === currentIndex.value) {
    curTime.value = curDur.value; // 进度条走满
  }
};
const doSeek = (v: number) => {
  const el = audioEls[currentIndex.value];
  if (el && isFinite(v)) el.currentTime = v;
};
const fmtTime = (s: number) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};
const currentEl = computed(() => (currentIndex.value >= 0 ? audioEls[currentIndex.value] : null));
const playerPaused = computed(() => {
  const el = currentEl.value;
  return !el || el.paused;
});
const nextSample = async () => {
  const list = filteredSamples.value;
  if (currentIndex.value < 0 || list.length === 0) return;
  const pos = list.findIndex(({ i }) => i === currentIndex.value);
  const next = list[(pos + 1) % list.length];
  if (next) await toggle(next.i, true);
};
const prevSample = async () => {
  const list = filteredSamples.value;
  if (currentIndex.value < 0 || list.length === 0) return;
  const pos = list.findIndex(({ i }) => i === currentIndex.value);
  const prev = list[(pos - 1 + list.length) % list.length];
  if (prev) await toggle(prev.i, true);
};
const closePlayer = () => {
  const el = currentEl.value;
  if (el) el.pause();
  currentIndex.value = -1;
  currentName.value = '';
  curTime.value = 0;
  curDur.value = 0;
};

// ---------------------------------------------------------------- 替换

const pickReplace = (i: number) => {
  replacingIndex.value = i;
  replaceInput.value?.click();
};

/** 把一条「原生 PCM」按当前开关（matchOriginal）推导成最终替换 PCM 并写入 replaced + 试听 URL */
const applyReplacement = async (
  i: number,
  native: { pcm: Int16Array; channels: number; sampleRate: number },
) => {
  const meta = samples.value[i];
  const match = matchOriginal.value;
  let pcm = native.pcm;
  let channels = native.channels;
  let sampleRate = native.sampleRate;
  let converted: ReplacedEntry['converted'];

  if (match) {
    const r = await resamplePcm16(native.pcm, native.channels, native.sampleRate, meta.channels, meta.frequency);
    pcm = r.pcm;
    channels = r.channels;
    sampleRate = r.sampleRate;
    if (r.channels !== native.channels || r.sampleRate !== native.sampleRate) {
      converted = { fromCh: native.channels, toCh: r.channels, fromRate: native.sampleRate, toRate: r.sampleRate };
    }
  }

  // 替换响度：把替换音音量归一化到原样本水平（RMS 匹配），避免忽大忽小
  if (matchLoudness.value) {
    try {
      const orig = await sampleToPcm16(i); // 解码/抠出原样本 PCM
      const origRms = computeRms(orig.pcm);
      const repRms = computeRms(pcm);
      if (origRms > 0 && repRms > 0) {
        const gain = Math.min(4, Math.max(0.2, origRms / repRms));
        pcm = scalePcm(pcm, gain);
      }
    } catch {
      // 响度匹配失败不中断替换，保留原样
    }
  }

  if (urls[i]) URL.revokeObjectURL(urls[i]);
  urls[i] = URL.createObjectURL(pcmToWavBlob(pcm, channels, sampleRate));
  replaced[i] = {
    nativePcm: native.pcm,
    nativeChannels: native.channels,
    nativeRate: native.sampleRate,
    pcm,
    channels,
    sampleRate,
    converted,
    native: !match,
  };
  saveSession();
};

const replaceWithFile = async (i: number, file: File) => {
  try {
    const native = await decodeAudioFileToPcm(file);
    await applyReplacement(i, native);
    const rep = replaced[i];
    if (rep?.converted) {
      ElMessage.success(`已替换「${samples.value[i].name}」（已匹配原格式 ${rep.converted.toCh}ch/${rep.converted.toRate}Hz）`);
    } else if (rep?.native) {
      ElMessage.success(`已替换「${samples.value[i].name}」（保留原生 ${rep.nativeChannels}ch/${rep.nativeRate}Hz）`);
    } else {
      ElMessage.success(`已替换「${samples.value[i].name}」`);
    }
  } catch (e) {
    console.error('[BankStudio] 替换解码失败', e);
    ElMessage.error(`替换失败：${e}`);
  }
};

/** 切换「匹配原格式」后，重算所有已替换样本的最终 PCM */
const onMatchOriginalChange = async () => {
  let n = 0;
  for (const k of Object.keys(replaced)) {
    const i = Number(k);
    const r = replaced[i];
    await applyReplacement(i, { pcm: r.nativePcm, channels: r.nativeChannels, sampleRate: r.nativeRate });
    n++;
  }
  if (n > 0) ElMessage.info(`已按「${matchOriginal.value ? '匹配原格式' : '保留原生格式'}」重算 ${n} 条替换`);
};

const onReplaceChosen = async (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const file = input.files?.[0];
  const i = replacingIndex.value;
  input.value = '';
  replacingIndex.value = -1;
  if (!file || i < 0) return;
  await replaceWithFile(i, file);
};

const undoReplace = async (i: number) => {
  if (urls[i]) {
    URL.revokeObjectURL(urls[i]);
    delete urls[i];
  }
  delete replaced[i];
  saveSession();
  ElMessage.info(`已还原「${samples.value[i].name}」`);
};

const onRowDragOver = (i: number, e: DragEvent) => {
  e.preventDefault();
  dragOverIndex.value = i;
};
const onRowDragLeave = (i: number, e: DragEvent) => {
  const related = e.relatedTarget as Node | null;
  const el = e.currentTarget as HTMLElement | null;
  if (el && !el.contains(related)) dragOverIndex.value = -1;
};
const onRowDrop = async (i: number, e: DragEvent) => {
  e.preventDefault();
  e.stopPropagation();
  dragOverIndex.value = -1;
  const file = e.dataTransfer?.files?.[0];
  if (file) await replaceWithFile(i, file);
};

// ---------------------------------------------------------------- 批量替换（C）

const openBatch = () => batchInput.value?.click();

const onBatchChosen = async (ev: Event) => {
  const input = ev.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = '';
  if (!files.length) return;
  const nameMap = new Map<string, File>();
  for (const f of files) {
    const base = f.name.replace(/\.[^.]+$/, '').toLowerCase();
    if (base) nameMap.set(base, f);
  }
  // 收集可匹配的样本索引
  const targets = samples.value.filter((s) => nameMap.has(s.name.toLowerCase()));
  if (targets.length === 0) {
    ElMessage.warning('没有文件名能匹配到样本（按「去扩展名、大小写不敏感」匹配 sample 名）');
    return;
  }
  batching.value = true;
  batchStatus.value = '';
  batchProgress.value = 0;
  let matched = 0;
  try {
    for (let idx = 0; idx < targets.length; idx++) {
      const s = targets[idx];
      batchStatus.value = `正在替换… ${idx + 1}/${targets.length}`;
      batchProgress.value = Math.round(((idx + 1) / targets.length) * 100);
      await replaceWithFile(s.index, nameMap.get(s.name.toLowerCase())!);
      matched++;
      // 让出主线程，避免长时间阻塞 UI
      await new Promise((r) => setTimeout(r, 0));
    }
    ElMessage.success(`批量替换完成：匹配并替换了 ${matched} 条`);
  } finally {
    batching.value = false;
    batchStatus.value = '';
  }
};

// ---------------------------------------------------------------- 单条导出 WAV（B）

const exportSampleWav = async (i: number) => {
  const { bytes, name } = await sampleToWav(i);
  downloadBytes(bytes, `${safeFileName(name)}.wav`);
  ElMessage.success(`已导出 ${name}.wav`);
};

// ---------------------------------------------------------------- 详情 / 波形 / A·B 对比（H + E）

const openDetail = async (i: number) => {
  detailIndex.value = i;
  detailOpen.value = true;
  await ensureOriginalPcm(i);
};

/** 按需解码原音 PCM 用于画波形（仅解码一次，缓存） */
const ensureOriginalPcm = async (i: number) => {
  if (wavePcm[i] || waveLoading[i]) return;
  waveLoading[i] = true;
  try {
    const { pcm, channels } = await sampleToPcm16(i);
    wavePcm[i] = { pcm, channels };
  } catch (e) {
    console.error('[BankStudio] 原音波形解码失败', e);
  } finally {
    waveLoading[i] = false;
  }
};

const playOriginal = async (i: number) => {
  if (!origUrls[i]) {
    const fsb = fsbBytes.value!;
    const meta = samples.value[i];
    const wav = await decodeFsbSubSound(fsb, fsb.length, meta.channels, meta.index, meta.frequency);
    const blob = new Blob([wav as unknown as BlobPart], { type: 'audio/wav' });
    origUrls[i] = URL.createObjectURL(blob);
  }
  const el = document.createElement('audio');
  el.src = origUrls[i];
  el.play().catch((err) => console.error('[BankStudio] 原音播放失败', err));
};

const drawWave = (
  canvas: HTMLCanvasElement | null,
  pcm: Int16Array | undefined,
  channels: number,
  color: string,
) => {
  if (!canvas) return;
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 320;
  const h = canvas.clientHeight || 64;
  canvas.width = Math.max(1, Math.floor(w * dpr));
  canvas.height = Math.max(1, Math.floor(h * dpr));
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  // 无 PCM（未替换）时清空画布并标出空态，避免残留上一张波形
  if (!pcm || pcm.length === 0) {
    ctx.fillStyle = 'rgba(128,128,128,0.18)';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('—', w / 2, h / 2);
    return;
  }
  ctx.strokeStyle = 'rgba(128,128,128,0.25)';
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  const frames = Math.floor(pcm.length / Math.max(1, channels));
  const step = Math.max(1, Math.floor(frames / w));
  ctx.fillStyle = color;
  for (let x = 0; x < w; x++) {
    const start = x * step;
    const end = Math.min(frames, start + step);
    let min = 1.0;
    let max = -1.0;
    for (let k = start; k < end; k++) {
      const v = pcm[k * channels] / 32768;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    const y1 = (1 - (max + 1) / 2) * h;
    const y2 = (1 - (min + 1) / 2) * h;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
};

const redrawDetailWaves = () => {
  const i = detailIndex.value;
  if (i < 0) return;
  const orig = wavePcm[i];
  drawWave(detailOrigCanvas.value, orig?.pcm, orig?.channels ?? 1, WAVE_ORIG_COLOR);
  const rep = replaced[i];
  drawWave(detailRepCanvas.value, rep?.pcm, rep?.channels ?? 1, WAVE_REP_COLOR);
};

watch(
  [
    detailOpen,
    detailIndex,
    () => (detailIndex.value >= 0 ? wavePcm[detailIndex.value] : null),
    () => (detailIndex.value >= 0 ? replaced[detailIndex.value] : null),
  ],
  async () => {
    if (detailOpen.value && detailIndex.value >= 0) {
      await nextTick();
      redrawDetailWaves();
    }
  },
);

// ---------------------------------------------------------------- 导出

/** 把「原始样本」统一转成交错 PCM16（PCM16 直接抠字节，否则走 FMOD 解码） */
const sampleToPcm16 = async (i: number): Promise<{ pcm: Int16Array; channels: number; sampleRate: number }> => {
  const fsb = fsbBytes.value!;
  const meta = samples.value[i];
  if (bankMode.value === FSB5_MODE_PCM16) {
    const direct = extractFsbSamplePcm(fsb, i);
    if (direct) return direct;
  }
  const wav = await decodeFsbSubSound(fsb, fsb.length, meta.channels, meta.index, meta.frequency);
  return wavToPcm16(wav);
};

const downloadBytes = (bytes: Uint8Array, name: string) => {
  const blob = new Blob([bytes as unknown as BlobPart], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/** 取某个样本的 WAV 字节：已替换用替换的 PCM，否则走 FMOD 解码 */
const sampleToWav = async (i: number): Promise<{ bytes: Uint8Array; name: string }> => {
  const meta = samples.value[i];
  const rep = replaced[i];
  if (rep) {
    const blobArr = await pcmToWavBlob(rep.pcm, rep.channels, rep.sampleRate).arrayBuffer();
    return { bytes: new Uint8Array(blobArr), name: meta.name };
  }
  const fsb = fsbBytes.value!;
  const wav = await decodeFsbSubSound(fsb, fsb.length, meta.channels, meta.index, meta.frequency);
  return { bytes: wav as unknown as Uint8Array, name: meta.name };
};

const safeFileName = (name: string) =>
  name.replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, '_');

// ---- 极简 ZIP 写入（STORE，无压缩，零依赖）----
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

/** 把若干文件打包成合法的 ZIP（STORE 存储，WAV/PCM 压缩收益低，故不压缩） */
const createZip = (files: { name: string; bytes: Uint8Array }[]): Uint8Array => {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const push = (u8: Uint8Array) => {
    chunks.push(u8);
    offset += u8.length;
  };

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.bytes);
    const size = f.bytes.length;
    const flags = 0x0800; // UTF-8 文件名

    // Local File Header
    const lfh = new Uint8Array(30);
    const lv = new DataView(lfh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, flags, true);
    lv.setUint16(8, 0, true); // STORE
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    const localOffset = offset;
    push(lfh);
    push(nameBytes);
    push(f.bytes);

    // Central Directory Record
    const cd = new Uint8Array(46);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, localOffset, true);
    central.push(cd);
    central.push(nameBytes);
  }

  const cdOffset = offset;
  const cdSize = central.reduce((s, u8) => s + u8.length, 0);

  // End of Central Directory
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, files.length, true);
  ev.setUint16(10, files.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, cdOffset, true);

  const out = new Uint8Array(offset + cdSize + eocd.length);
  let pos = 0;
  for (const c of [...chunks, ...central, eocd]) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
};

/** 全部导出：把每个子音频解码成独立 WAV，打包成一个 ZIP 下载 */
const exportAll = async () => {
  if (samples.value.length === 0) return;
  exporting.value = true;
  exportStatus.value = '';
  exportProgress.value = 0;
  try {
    const files: { name: string; bytes: Uint8Array }[] = [];
    for (let i = 0; i < samples.value.length; i++) {
      exportStatus.value = `正在导出 WAV… ${i + 1}/${samples.value.length}`;
      exportProgress.value = Math.round(((i + 1) / samples.value.length) * 70);
      const { bytes, name } = await sampleToWav(i);
      files.push({ name: `${safeFileName(name)}.wav`, bytes });
      // 让出主线程，避免长时间阻塞 UI
      if (i % 4 === 3) await new Promise((r) => setTimeout(r, 0));
    }
    exportStatus.value = '正在打包 ZIP…';
    exportProgress.value = 88;
    const zip = createZip(files);
    const base = (fileName.value.replace(/\.[^.]+$/, '') || 'bank').trim();
    const zipName = `${safeFileName(base)}_wavs.zip`;
    downloadBytes(zip, zipName);
    exportProgress.value = 100;
    exportStatus.value = `已导出 ${files.length} 个 WAV（${zipName}）`;
    ElMessage.success(`已导出 ${files.length} 个 WAV 压缩包`);
  } catch (e) {
    console.error('[BankStudio] 全部导出失败', e);
    ElMessage.error(`全部导出失败：${(e as Error).message}`);
    exportStatus.value = '';
    exportProgress.value = 0;
  } finally {
    exporting.value = false;
  }
};

const onExport = async () => {
  if (!fsbBytes.value || samples.value.length === 0) return;
  exporting.value = true;
  exportStatus.value = '';
  exportProgress.value = 0;
  try {
    const fsb = fsbBytes.value;
    const outName = fileName.value.replace(/\.(bank|fsb5|fsb)$/i, '') + '.repack.bank';
    let newFsb: Uint8Array;
    // 被替换样本的新旧帧数：写回容器时用于同步前缀里的时长标记
    let rawPairs: { index: number; oldFrames: number; newFrames: number }[] = [];

    if (exportMethod.value === 'incremental') {
      exportStatus.value = '正在重打包（未替换样本字节原样保留）…';
      exportProgress.value = 20;
      const replacements = new Map(
        Object.entries(replaced).map(([k, v]) => [Number(k), v]),
      );
      const { fsb: out, report } = await repackFsb5Incremental(fsb, replacements);
      newFsb = out;
      // 采样率变了的替换样本不参与时长标记同步（标记单位是帧数，换率后无法可靠换算）
      rawPairs = Object.entries(report.lengthPatchByIndex)
        .map(([k, v]) => ({ index: Number(k), ...v }))
        .filter((p) => {
          const conv = report.convertedByIndex[p.index];
          return !conv || conv.fromRate === conv.toRate;
        });
      exportProgress.value = 95;
      const conv = Object.keys(report.convertedByIndex).length;
      const dropped = Object.keys(report.droppedLoopByIndex).length;
      exportStatus.value = `增量完成：${report.originalSize}B → ${report.newSize}B（${conv} 条格式转换${
        dropped ? `，${dropped} 条丢弃失效 loop` : ''
      }）`;
    } else {
      exportStatus.value = '正在把全部样本转成 PCM16…';
      const ws: FsbWriteSample[] = [];
      for (let i = 0; i < samples.value.length; i++) {
        const rep = replaced[i];
        if (rep) {
          ws.push({ name: samples.value[i].name, pcm: rep.pcm, channels: rep.channels, sampleRate: rep.sampleRate });
          // 与 writeFsb5 的 frameCount 算法一致；采样率变了的样本不参与时长标记同步
          if (rep.sampleRate === samples.value[i].frequency) {
            rawPairs.push({
              index: i,
              oldFrames: samples.value[i].sampleCount,
              newFrames: Math.floor(rep.pcm.length / rep.channels),
            });
          }
        } else {
          const { pcm, channels, sampleRate } = await sampleToPcm16(i);
          ws.push({ name: samples.value[i].name, pcm, channels, sampleRate });
        }
        exportProgress.value = Math.round(((i + 1) / samples.value.length) * 70);
        exportStatus.value = `正在转 PCM16… ${i + 1}/${samples.value.length}`;
      }
      newFsb = writeFsb5(ws, FSB5_MODE_PCM16);
      exportProgress.value = 95;
      exportStatus.value = `PCM16 全量完成：${fsb.length}B → ${newFsb.length}B`;
    }

    // 时长标记同步过滤：旧帧数与未替换样本撞值、或多条替换共用同一旧帧数时跳过（按值匹配会误伤）
    const replacedIdx = new Set(rawPairs.map((p) => p.index));
    const oldCount = new Map<number, number>();
    rawPairs.forEach((p) => oldCount.set(p.oldFrames, (oldCount.get(p.oldFrames) ?? 0) + 1));
    const lengthPairs = rawPairs.filter((p) => {
      if ((oldCount.get(p.oldFrames) ?? 0) > 1) return false;
      return !samples.value.some((s, i) => i !== p.index && !replacedIdx.has(i) && s.sampleCount === p.oldFrames);
    });

    // 容器写回：原始文件是容器（fsbOffset>0）时包回 RIFF 前缀，
    // 并同步前缀里的音频时长标记与 FSB 体积缓存（否则游戏仍按旧时长截断播放）
    let lengthPatched = 0;
    let finalBytes: Uint8Array;
    if (fsbOffset.value > 0 && originalBytes.value) {
      const wrap = wrapFsbInContainer(originalBytes.value, fsbOffset.value, newFsb, {
        oldFsbSize: fsb.length,
        lengthPairs,
      });
      finalBytes = wrap.bytes;
      lengthPatched = wrap.lengthPatched;
    } else {
      finalBytes = newFsb;
    }

    exportProgress.value = 100;
    // G 导出自检：用高层解析器重解析，确认是合法 FSB5 且样本数一致
    // 传入容器中的 FSB offset，避免容器（RIFF 前缀）被误判为非法 FSB5
    const check = selfCheckRepacked(finalBytes, samples.value.length, fsbOffset.value);
    selfCheck.value = check;
    downloadBytes(finalBytes, outName);
    ElMessage.success(
      `已导出 ${outName}${check.ok ? '' : '（⚠️ 自检异常，见下方提示）'}` +
        (lengthPatched > 0 ? `（已同步 ${lengthPatched} 处容器时长标记）` : ''),
    );
  } catch (e) {
    console.error('[BankStudio] 导出失败', e);
    ElMessage.error(`导出失败：${(e as Error).message}`);
    exportStatus.value = '';
    exportProgress.value = 0;
  } finally {
    exporting.value = false;
  }
};

const onClear = async () => {
  if (replacedCount.value === 0) {
    ElMessage.info('还没有替换过任何样本');
    return;
  }
  try {
    await ElMessageBox.confirm('确定要撤销所有替换吗？', '撤销替换', { type: 'warning' });
  } catch {
    return;
  }
  for (const k of Object.keys(replaced)) {
    const i = Number(k);
    // 撤销后恢复原始解码（若已生成替换试听 URL 则清掉，下次播放重新解码）
    if (urls[i]) {
      URL.revokeObjectURL(urls[i]);
      delete urls[i];
    }
    delete replaced[i];
  }
  clearSession();
  ElMessage.success('已撤销全部替换');
};

onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown);
  Object.values(urls).forEach((u) => u && URL.revokeObjectURL(u));
});
</script>

<template>
  <div class="bank-studio" @dragover.prevent @drop.prevent="onDrop">
    <!-- 主题切换（仅空态显示为右上角悬浮按钮） -->
    <div v-if="!hasContent" class="theme-float">
      <el-popover
        v-model:visible="themePop"
        placement="bottom-end"
        :width="240"
        trigger="click"
        popper-class="theme-pop"
      >
        <template #reference>
          <button class="theme-fab" title="外观设置" :aria-expanded="themePop">
            <el-icon><MagicStick /></el-icon>
          </button>
        </template>
        <div class="theme-panel">
          <div class="tp-label">强调色</div>
          <div class="tp-swatches">
            <button
              v-for="a in ACCENTS"
              :key="a.key"
              class="swatch"
              :class="{ active: accentKey === a.key }"
              :style="{ '--sw': a.color }"
              :title="a.label"
              @click="accentKey = a.key"
            >
              <el-icon v-if="accentKey === a.key"><Check /></el-icon>
            </button>
          </div>
          <div class="tp-label">主题模式</div>
          <div class="tp-mode">
            <button :class="{ active: isDark }" @click="isDark = true">
              <el-icon><Moon /></el-icon>夜间
            </button>
            <button :class="{ active: !isDark }" @click="isDark = false">
              <el-icon><Sunny /></el-icon>日间
            </button>
          </div>
        </div>
      </el-popover>
    </div>

    <!-- 空态：拖入 / 选择 bank -->
    <div v-if="!hasContent" class="empty">
      <div class="empty-icon">
        <div class="halo"></div>
        <el-icon :size="52"><Headset /></el-icon>
        <div class="wave">
          <span v-for="n in 5" :key="n"></span>
        </div>
      </div>
      <h2>Bank Studio Web</h2>
      <p>把 <code>.bank</code> / <code>.fsb</code> / <code>.fsb5</code> 音频 bank 拖到这里，或点击选择文件</p>
      <el-button type="primary" size="large" @click="onPickFile">
        <el-icon style="margin-right: 6px"><FolderOpened /></el-icon>
        选择 Bank 文件
      </el-button>
      <el-button size="large" @click="openCharDialog" style="margin-left: 8px">
        <el-icon style="margin-right: 6px"><Search /></el-icon>
        角色对照查询
      </el-button>
      <p class="empty-hint">支持查看/试听全部子音频、用本地音频替换样本，并导出重打包 bank（Vorbis 增量或全量 PCM16）</p>

      <!-- 上次会话可恢复 -->
      <div v-if="restoreRaw" class="restore-card">
        <el-icon class="restore-icon"><InfoFilled /></el-icon>
        <div class="restore-info">
          <div class="restore-title">检测到上次未完成的会话</div>
          <div class="restore-sub">{{ restoreRaw.fileName }} · {{ restoreRaw.replaces.length }} 个替换</div>
        </div>
        <el-button size="small" type="primary" :loading="restoring" @click="doRestore">恢复</el-button>
        <el-button size="small" @click="discardRestore">取消</el-button>
      </div>

      <!-- 最近打开 -->
      <div v-if="recentList.length" class="recent">
        <div class="recent-head">
          <span class="recent-h">最近打开</span>
          <button class="recent-clear" @click="clearAllRecent" title="清空列表">清空</button>
        </div>
        <button
          v-for="r in recentList"
          :key="r.name"
          class="recent-item"
          :title="r.name"
          @click="openRecent(r)"
        >
          <el-icon class="recent-file-ic"><Document /></el-icon>
          <span class="recent-name">{{ r.name }}</span>
          <span class="recent-time">{{ fmtRecentTime(r.time) }}</span>
          <el-icon class="recent-del" title="移除" @click.stop="delRecent(r.name)"><Back /></el-icon>
        </button>
      </div>
    </div>

    <!-- 已加载 -->
    <template v-else>
      <div class="bar">
        <div class="bar-left">
          <el-icon class="bar-icon"><Headset /></el-icon>
          <span class="bar-file" :title="fileName">{{ fileName }}</span>
          <el-tag size="small" type="info" effect="plain">{{ codecName(bankMode) }}</el-tag>
          <el-tag size="small" type="info" effect="plain">{{ samples.length }} 个音频</el-tag>
          <el-button v-if="replacedCount > 0" size="small" text type="info" @click="onClear">
            撤销全部替换 ({{ replacedCount }})
          </el-button>
        </div>
        <div class="bar-right">
          <el-button size="small" @click="openCharDialog" style="margin-right: 8px">
            <el-icon style="margin-right: 4px"><Search /></el-icon>
            角色对照
          </el-button>
          <el-tooltip content="替换时把替换音重采样到原样本的声道/采样率（保真）；关闭则保留替换音原生格式" placement="bottom">
            <span class="match-switch">
              <el-switch v-model="matchOriginal" size="small" @change="onMatchOriginalChange" />
              <span class="match-label">匹配原格式</span>
            </span>
          </el-tooltip>
          <el-tooltip content="替换时把替换音音量归一化到原样本水平（RMS 匹配），避免忽大忽小；关闭则保留替换音原始音量" placement="bottom">
            <span class="match-switch">
              <el-switch v-model="matchLoudness" size="small" />
              <span class="match-label">匹配响度</span>
            </span>
          </el-tooltip>
          <el-button size="small" @click="openBatch">
            <el-icon style="margin-right: 4px"><Files /></el-icon>
            批量替换
          </el-button>
          <el-button size="small" @click="openReverseDialog">
            <el-icon style="margin-right: 4px"><Search /></el-icon>
            反向查询
          </el-button>
          <el-popover
            v-model:visible="themePop"
            placement="bottom-end"
            :width="240"
            trigger="click"
            popper-class="theme-pop"
          >
            <template #reference>
              <el-button size="small" class="bar-theme-btn" title="外观设置">
                <el-icon><MagicStick /></el-icon>
              </el-button>
            </template>
            <div class="theme-panel theme-panel--bar">
              <div class="tp-label">强调色</div>
              <div class="tp-swatches">
                <button
                  v-for="a in ACCENTS"
                  :key="a.key"
                  class="swatch"
                  :class="{ active: accentKey === a.key }"
                  :style="{ '--sw': a.color }"
                  :title="a.label"
                  @click="accentKey = a.key"
                >
                  <el-icon v-if="accentKey === a.key"><Check /></el-icon>
                </button>
              </div>
              <div class="tp-label">主题模式</div>
              <div class="tp-mode">
                <button :class="{ active: isDark }" @click="isDark = true">
                  <el-icon><Moon /></el-icon>夜间
                </button>
                <button :class="{ active: !isDark }" @click="isDark = false">
                  <el-icon><Sunny /></el-icon>日间
                </button>
              </div>
            </div>
          </el-popover>
          <el-select v-model="exportMethod" size="small" style="width: 190px">
            <el-option
              v-for="m in exportMethods"
              :key="m.value"
              :value="m.value"
              :label="m.label"
            />
          </el-select>
          <el-button type="primary" :loading="exporting" @click="onExport">
            <el-icon v-if="!exporting" style="margin-right: 4px"><Download /></el-icon>
            {{ exporting ? '导出中…' : '导出 bank' }}
          </el-button>
          <el-button type="success" :loading="exporting" @click="exportAll" style="margin-left: 8px">
            <el-icon v-if="!exporting" style="margin-right: 4px"><FolderOpened /></el-icon>
            全部导出
          </el-button>
        </div>
      </div>

      <div v-if="exportStatus || exporting" class="status" :class="{ done: !exporting }">
        <div class="status-text">{{ exportStatus }}</div>
        <el-progress
          v-if="exporting"
          class="status-progress"
          :percentage="exportProgress"
          :stroke-width="4"
          :show-text="false"
        />
      </div>

      <div v-if="batching" class="status">
        <div class="status-text">{{ batchStatus }}</div>
        <el-progress class="status-progress" :percentage="batchProgress" :stroke-width="4" :show-text="false" />
      </div>

      <div v-if="selfCheck" class="selfcheck" :class="selfCheck.ok ? 'ok' : 'warn'">
        <el-icon><CircleCheck v-if="selfCheck.ok" /><Warning v-else /></el-icon>
        <span>导出自检：{{ selfCheck.messages.join('；') }}</span>
      </div>

      <div class="toolbar">
        <div class="search" :class="{ focus: searchFocus }">
          <el-icon class="search-icon"><Search /></el-icon>
          <input
            v-model="search"
            type="text"
            placeholder="筛选样本名称…"
            @focus="searchFocus = true"
            @blur="searchFocus = false"
          />
          <button v-if="search" class="search-clear" @click="search = ''" title="清空">
            <el-icon><Back /></el-icon>
          </button>
        </div>
        <div class="filter-bar">
          <el-select v-model="filterCodec" size="small" placeholder="编码格式" clearable style="width: 110px">
            <el-option v-for="o in codecOptions" :key="o.value" :label="o.label" :value="o.value" />
          </el-select>
          <el-select v-model="filterChannels" size="small" placeholder="声道" clearable style="width: 92px">
            <el-option label="单声道" :value="1" />
            <el-option label="立体声" :value="2" />
            <el-option label="4 声道" :value="4" />
            <el-option label="6 声道" :value="6" />
          </el-select>
          <el-select v-model="filterReplaced" size="small" style="width: 110px">
            <el-option label="全部" value="all" />
            <el-option label="仅已替换" value="replaced" />
            <el-option label="仅原版" value="original" />
          </el-select>
          <button v-if="hasActiveFilter" class="filter-clear" @click="clearFilters" title="清除全部筛选">
            <el-icon><RefreshLeft /></el-icon>
          </button>
        </div>
        <span class="count-hint">{{ filteredSamples.length }} / {{ samples.length }}</span>
      </div>

      <div class="hint">
        点每行「替换」或把音频拖到该行即可替换试听；「批量替换」可按文件名一次性替换多首；「匹配原格式」开关控制替换音是否重采样到原样本声道/采样率（保真）。
        点 ▶ 试听原音，点 ℹ 看样本详情与波形 A·B 对比，点 ⬇ 导出单条 WAV。
      </div>

      <div v-if="filteredSamples.length === 0" class="no-result">
        <el-icon><Search /></el-icon>
        <span>没有匹配「{{ search }}」的样本</span>
      </div>

      <div class="list">
        <div
          v-for="({ s, i }) in pagedSamples"
          :key="s.index"
          class="row"
          :class="{ 'drag-over': dragOverIndex === i, playing: isPlaying(i), replaced: isReplaced(i) }"
          @dragover.prevent="onRowDragOver(i, $event)"
          @dragleave="onRowDragLeave(i, $event)"
          @drop.prevent.stop="onRowDrop(i, $event)"
        >
          <div v-if="dragOverIndex === i" class="row-drop-hint">
            <el-icon><Upload /></el-icon>
            <span>松开以替换「{{ s.name }}」</span>
          </div>
          <div class="row-main">
            <button class="play" :class="{ playing: isPlaying(i) }" @click="toggle(i)" :title="loading[i] ? '解码中…' : '播放'">
              <el-icon v-if="loading[i]"><Loading class="is-loading" /></el-icon>
              <el-icon v-else-if="isPlaying(i)"><VideoPause /></el-icon>
              <el-icon v-else><VideoPlay /></el-icon>
            </button>
            <div class="eq" :class="{ on: isPlaying(i) }">
              <span v-for="n in 4" :key="n"></span>
            </div>
            <div class="info">
              <div class="name" :title="s.name">{{ s.name }}</div>
              <div class="tags">
                <span class="tag">{{ codecName(s.mode) }}</span>
                <span class="tag">{{ s.channels === 1 ? '单声道' : s.channels + ' 声道' }}</span>
                <span class="tag">{{ s.frequency }} Hz</span>
                <span class="tag">{{ formatDuration(s.duration) }}</span>
                <span v-if="isReplaced(i)" class="tag replaced">已替换</span>
                <span v-if="isReplaced(i) && replacedDuration(i) > 0" class="tag duration-diff" :class="{ longer: replacedDuration(i) > s.duration, shorter: replacedDuration(i) < s.duration }">
                  {{ formatDuration(s.duration) }} → {{ formatDuration(replacedDuration(i)) }}
                </span>
                <span v-if="replaced[i]?.converted" class="tag converted">已匹配 {{ replaced[i]?.converted?.toCh }}ch/{{ replaced[i]?.converted?.toRate }}Hz</span>
                <span v-else-if="replaced[i]?.native" class="tag raw">原生 {{ replaced[i]?.nativeChannels }}ch/{{ replaced[i]?.nativeRate }}Hz</span>
              </div>
            </div>
            <div class="row-actions">
              <button class="icon-btn" title="导出该条 WAV" @click="exportSampleWav(i)">
                <el-icon><Download /></el-icon>
              </button>
              <button class="icon-btn" title="样本详情 / 波形 / A·B 对比" @click="openDetail(i)">
                <el-icon><InfoFilled /></el-icon>
              </button>
              <button v-if="isReplaced(i)" class="icon-btn undo" title="还原该样本" @click="undoReplace(i)">
                <el-icon><Back /></el-icon>
              </button>
              <button class="replace" title="用本地音频替换该样本" @click="pickReplace(i)">
                <el-icon><Refresh /></el-icon>
                <span>替换</span>
              </button>
            </div>
            <div class="idx">#{{ s.index }}</div>
          </div>
          <audio
            :ref="(el: any) => (audioEls[i] = el as HTMLAudioElement | null)"
            :src="urls[i]"
            class="audio"
            preload="metadata"
            @play="onPlay(i)"
            @pause="onPause(i)"
            @ended="onEndedInner(i)"
            @loadedmetadata="onMeta(i, $event)"
            @timeupdate="onTime(i, $event)"
          />
        </div>
      </div>

      <div v-if="hasMore" class="list-more">
        <button class="list-more-btn" @click="loadMore">
          <el-icon><Bottom /></el-icon>
          <span>显示更多（已显示 {{ pagedSamples.length }} / {{ filteredSamples.length }}）</span>
        </button>
      </div>

      <!-- 统一播放条 -->
      <div v-if="currentIndex >= 0" class="player">
        <div class="player-left">
          <button class="player-btn" title="上一首" @click="prevSample">
            <el-icon><ArrowLeftBold /></el-icon>
          </button>
          <button class="player-btn primary" :title="playerPaused ? '播放' : '暂停'" @click="toggle(currentIndex)">
            <el-icon v-if="playerPaused"><VideoPlay /></el-icon>
            <el-icon v-else><VideoPause /></el-icon>
          </button>
          <button class="player-btn" title="下一首" @click="nextSample">
            <el-icon><ArrowRightBold /></el-icon>
          </button>
        </div>
        <div class="player-info" :title="currentName">
          <span class="player-name">{{ currentName }}</span>
        </div>
        <div class="player-center">
          <span class="player-time">{{ fmtTime(curTime) }}</span>
          <input
            class="player-seek"
            type="range"
            min="0"
            :max="curDur || 0"
            step="0.1"
            :value="curTime"
            :disabled="!curDur"
            @input="doSeek(Number(($event.target as HTMLInputElement).value))"
          />
          <span class="player-time">{{ fmtTime(curDur) }}</span>
        </div>
        <button class="player-btn close-btn" title="关闭" @click="closePlayer">
          <el-icon><Close /></el-icon>
        </button>
      </div>
    </template>

    <input
      ref="fileInput"
      type="file"
      accept=".bank,.fsb,.fsb5,audio/bank"
      style="display: none"
      @change="onFileChosen"
    />
    <input
      ref="replaceInput"
      type="file"
      accept="audio/*"
      style="display: none"
      @change="onReplaceChosen"
    />
    <input
      ref="batchInput"
      type="file"
      accept="audio/*"
      multiple
      webkitdirectory
      style="display: none"
      @change="onBatchChosen"
    />

    <!-- 角色 ↔ 音频库 对照查询弹窗 -->
    <el-dialog
      v-model="charDialog"
      title="角色 ↔ 音频库 对照查询"
      width="min(520px, 92vw)"
      :close-on-click-modal="false"
      append-to-body
    >
      <div class="char-search">
        <el-icon class="char-search-icon"><Search /></el-icon>
        <input
          v-model="charQuery"
          type="text"
          class="char-search-input"
          placeholder="输入角色名，如：漩涡鸣人、佐助…"
          autofocus
        />
        <button v-if="charQuery" class="char-search-clear" @click="charQuery = ''" title="清空">
          <el-icon><Back /></el-icon>
        </button>
      </div>

      <div v-if="!charQuery.trim()" class="char-tip">输入关键词开始查询对应的音频库文件</div>
      <div v-else-if="charResults.length === 0" class="char-tip empty">未找到匹配的角色</div>
      <ul v-else class="char-list">
        <li v-for="item in charResults" :key="item.name" class="char-item">
          <span class="char-name">{{ item.name }}</span>
          <span class="char-banks">
            <el-tag
              v-for="bank in item.banks"
              :key="bank"
              size="small"
              class="char-bank"
              @click="copyBank(bank)"
            >
              {{ bank }}
            </el-tag>
          </span>
        </li>
        <li v-if="charResults.length === 200" class="char-more">结果过多，仅显示前 200 条，请细化关键词</li>
      </ul>
    </el-dialog>

    <!-- 样本详情 / 波形 / A·B 对比 抽屉（H + E） -->
    <el-drawer
      v-model="detailOpen"
      :title="detailMeta ? '样本详情 · ' + detailMeta.name : '样本详情'"
      size="min(460px, 94vw)"
      direction="rtl"
      append-to-body
      @opened="redrawDetailWaves"
    >
      <div v-if="detailMeta" class="detail">
        <div class="detail-block">
          <div class="detail-h">基本信息</div>
          <table class="detail-tbl">
            <tbody>
              <tr><td>索引</td><td>#{{ detailMeta.index }}</td></tr>
              <tr><td>名称</td><td>{{ detailMeta.name }}</td></tr>
              <tr><td>编码</td><td>{{ codecName(bankMode) }}</td></tr>
              <tr><td>声道数</td><td>{{ detailMeta.channels }}</td></tr>
              <tr><td>采样率</td><td>{{ detailMeta.sampleRate }} Hz</td></tr>
              <tr><td>时长</td><td>{{ formatDuration(detailMeta.frameCount / Math.max(1, detailMeta.sampleRate)) }}</td></tr>
              <tr><td>帧数</td><td>{{ detailMeta.frameCount }}</td></tr>
              <tr><td>数据偏移</td><td>{{ detailMeta.dataOffset }} B（×32 对齐）</td></tr>
              <tr><td>Vorbis CRC</td><td>{{ detailMeta.vorbisCrc != null ? '0x' + hex8(detailMeta.vorbisCrc) : '—' }}</td></tr>
              <tr>
                <td>extra 块</td>
                <td>{{ detailMeta.chunks.length }} 个（{{ detailMeta.chunks.map((c) => CHUNK_NAMES[c.type] || 'type ' + c.type).join('、') || '无' }}）</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="detail-block">
          <div class="detail-h">波形 / A·B 对比</div>
          <div class="ab">
            <div class="ab-col">
              <div class="ab-head">
                <span>原音</span>
                <button class="ab-play" title="播放原音" @click="playOriginal(detailIndex)">
                  <el-icon><VideoPlay /></el-icon>
                </button>
              </div>
              <canvas ref="detailOrigCanvas" class="wave-canvas"></canvas>
              <div v-if="waveLoading[detailIndex]" class="wave-tip">原音解码中…</div>
            </div>
            <div class="ab-col">
              <div class="ab-head">
                <span>替换后</span>
                <button v-if="isReplaced(detailIndex)" class="ab-play" title="播放替换后" @click="toggle(detailIndex)">
                  <el-icon><VideoPlay /></el-icon>
                </button>
              </div>
              <canvas ref="detailRepCanvas" class="wave-canvas"></canvas>
              <div v-if="!isReplaced(detailIndex)" class="wave-tip">未替换</div>
            </div>
          </div>
          <p class="detail-note">原音波形按需解码（首次打开稍慢）；替换后波形为已载入的 PCM。颜色：蓝=原音，绿=替换后。</p>
        </div>
      </div>
    </el-drawer>

    <!-- 反向查询：当前 bank 归属的角色（B） -->
    <el-dialog v-model="reverseDialog" title="反向查询：当前 bank 归属角色" width="min(520px, 92vw)" append-to-body>
      <div v-if="!fileName" class="char-tip">尚未载入 bank</div>
      <div v-else-if="reverseResults.length === 0" class="char-tip empty">「{{ fileName }}」未在角色对照表中找到对应角色</div>
      <ul v-else class="char-list">
        <li v-for="item in reverseResults" :key="item.name" class="char-item">
          <span class="char-name">{{ item.name }}</span>
          <span class="char-banks">
            <el-tag
              v-for="bank in item.banks"
              :key="bank"
              size="small"
              class="char-bank"
              @click="copyBank(bank)"
            >
              {{ bank }}
            </el-tag>
          </span>
        </li>
      </ul>
    </el-dialog>
  </div>
</template>

<style lang="scss" scoped>
.bank-studio {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: linear-gradient(160deg, var(--bg-2) 0%, var(--bg) 100%);
  color: var(--text);
  overflow: hidden;
}

/* ---------- 主题悬浮按钮 ---------- */
.theme-float {
  position: absolute;
  top: 14px;
  right: 14px;
  z-index: 20;
}
.theme-fab {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: var(--panel-2);
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 17px;
  box-shadow: var(--shadow-md);
  transition: transform var(--dur) var(--ease), color var(--dur) var(--ease),
    box-shadow var(--dur) var(--ease), border-color var(--dur) var(--ease);
  &:hover {
    color: var(--accent);
    border-color: var(--accent);
    transform: rotate(30deg) scale(1.05);
    box-shadow: 0 6px 20px var(--accent-glow);
  }
}
.theme-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
  .tp-label {
    font-size: 11px;
    color: var(--text-faint);
    letter-spacing: 0.05em;
  }
  .tp-swatches {
    display: flex;
    gap: 8px;
  }
  .swatch {
    width: 26px;
    height: 26px;
    border-radius: 50%;
    border: 2px solid transparent;
    background: var(--sw);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 13px;
    transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
    &:hover {
      transform: scale(1.15);
    }
    &.active {
      box-shadow: 0 0 0 2px var(--panel-2), 0 0 0 4px var(--sw);
      transform: scale(1.1);
    }
  }
  .tp-mode {
    display: flex;
    gap: 8px;
    button {
      flex: 1;
      height: 32px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--panel-3);
      color: var(--text-dim);
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-size: 12px;
      cursor: pointer;
      transition: all var(--dur) var(--ease);
      &.active {
        background: var(--accent-soft);
        border-color: var(--accent);
        color: var(--accent);
      }
      &:hover:not(.active) {
        border-color: var(--border-strong);
        color: var(--text);
      }
    }
  }
}

/* ---------- 空态 ---------- */
.empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  padding: 24px;
  text-align: center;
  border: 2px dashed var(--border);
  border-radius: 20px;
  margin: 16px;
  background: rgba(255, 255, 255, 0.015);
  backdrop-filter: blur(2px);
  transition: border-color var(--dur-slow) var(--ease);

  &:hover {
    border-color: var(--accent-glow);
  }

  .empty-icon {
    position: relative;
    color: var(--accent);
    display: flex;
    align-items: center;
    justify-content: center;
    .halo {
      position: absolute;
      inset: -18px;
      border-radius: 50%;
      background: radial-gradient(circle, var(--accent-glow), transparent 70%);
      animation: breathe 3s ease-in-out infinite;
    }
  }

  h2 {
    margin: 0;
    font-size: 26px;
    font-weight: 700;
    letter-spacing: 0.5px;
    background: linear-gradient(120deg, var(--text), var(--accent-2));
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
  }
  p {
    margin: 0;
    color: var(--text-dim);
    font-size: 14px;
    code {
      background: var(--panel-3);
      padding: 2px 6px;
      border-radius: 5px;
      font-size: 12px;
      color: var(--accent-2);
    }
  }
  .empty-hint {
    margin-top: 4px;
    font-size: 12px;
    max-width: 440px;
    line-height: 1.7;
    color: var(--text-faint);
  }

  .wave {
    position: absolute;
    bottom: -34px;
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 22px;
    span {
      width: 4px;
      border-radius: 2px;
      background: var(--accent);
      animation: wave 1.1s ease-in-out infinite;
      &:nth-child(1) { height: 8px; animation-delay: 0s; }
      &:nth-child(2) { height: 16px; animation-delay: 0.15s; }
      &:nth-child(3) { height: 22px; animation-delay: 0.3s; }
      &:nth-child(4) { height: 14px; animation-delay: 0.45s; }
      &:nth-child(5) { height: 10px; animation-delay: 0.6s; }
    }
  }

  .restore-card {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    max-width: 460px;
    padding: 12px 14px;
    border-radius: 12px;
    border: 1px solid var(--accent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    box-shadow: 0 0 20px var(--accent-glow);
    text-align: left;
    animation: fadeUp 0.4s var(--ease);

    .restore-icon {
      color: var(--accent);
      font-size: 20px;
      flex-shrink: 0;
    }
    .restore-info {
      flex: 1;
      min-width: 0;
      .restore-title {
        font-size: 13px;
        font-weight: 600;
        color: var(--text);
      }
      .restore-sub {
        font-size: 12px;
        color: var(--text-dim);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
    }
  }

  .recent {
    width: 100%;
    max-width: 460px;
    text-align: left;
    animation: fadeUp 0.4s var(--ease);

    .recent-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 6px;
      .recent-h {
        font-size: 12px;
        font-weight: 600;
        color: var(--text-dim);
        letter-spacing: 0.5px;
      }
      .recent-clear {
        border: none;
        background: none;
        color: var(--text-faint);
        font-size: 12px;
        cursor: pointer;
        padding: 2px 4px;
        border-radius: 4px;
        transition: color var(--dur) var(--ease);
        &:hover { color: var(--accent); }
      }
    }

    .recent-item {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 8px 10px;
      margin-bottom: 4px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--panel-2);
      cursor: pointer;
      color: var(--text);
      font-size: 13px;
      text-align: left;
      transition: border-color var(--dur) var(--ease), transform var(--dur) var(--ease),
        box-shadow var(--dur) var(--ease);
      &:hover {
        border-color: var(--accent);
        transform: translateY(-1px);
        box-shadow: 0 4px 14px var(--accent-glow);
      }
      .recent-file-ic { color: var(--accent); flex-shrink: 0; }
      .recent-name {
        flex: 1;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .recent-time { font-size: 11px; color: var(--text-faint); flex-shrink: 0; }
      .recent-del {
        color: var(--text-faint);
        flex-shrink: 0;
        padding: 2px;
        border-radius: 4px;
        transition: color var(--dur) var(--ease);
        &:hover { color: var(--danger, #f56c6c); }
      }
    }
  }
}

/* ---------- 顶栏 ---------- */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 55%, transparent);
  backdrop-filter: blur(12px);
  position: sticky;
  top: 0;
  z-index: 10;

  .bar-left {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;

    .bar-icon {
      color: var(--accent);
      font-size: 18px;
      filter: drop-shadow(0 0 6px var(--accent-glow));
    }
    .bar-file {
      font-weight: 600;
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
  .bar-right {
    display: flex;
    align-items: center;
    gap: 10px;

    .bar-theme-btn.el-button {
      width: 32px;
      padding: 0;
      justify-content: center;
      color: var(--text-dim);
      transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
        transform var(--dur) var(--ease);
      &:hover {
        color: var(--accent);
        border-color: var(--accent);
        transform: rotate(30deg);
      }
    }
  }
}

/* ---------- 状态条 ---------- */
.status {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  font-size: 12px;
  color: var(--ok);
  background: rgba(127, 209, 160, 0.08);
  border-bottom: 1px solid var(--border);
  animation: slideIn var(--dur) var(--ease);

  .status-text {
    flex-shrink: 0;
  }
  .status-progress {
    flex: 1;
    max-width: 320px;
  }
  &.done {
    color: var(--ok);
  }
}

/* ---------- 工具栏（搜索） ---------- */
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 10px 16px 4px;
}
.search {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 340px;
  height: 34px;
  padding: 0 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-2);
  transition: border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);

  &.focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
  .search-icon {
    color: var(--text-faint);
    font-size: 15px;
  }
  input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font-size: 13px;
    &::placeholder {
      color: var(--text-faint);
    }
  }
  .search-clear {
    border: none;
    background: transparent;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    font-size: 14px;
    padding: 2px;
    &:hover {
      color: var(--accent);
    }
  }
}
.count-hint {
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* 高级筛选条 */
.filter-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.filter-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  font-size: 14px;
  transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
  &:hover {
    color: var(--accent);
    border-color: var(--accent);
  }
}

/* ---------- 提示条 ---------- */
.hint {
  padding: 6px 16px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-faint);
}

/* ---------- 无结果 ---------- */
.no-result {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px 16px;
  color: var(--text-faint);
  font-size: 13px;
}

/* ---------- 列表 ---------- */
.list {
  flex: 1;
  overflow-y: auto;
  padding: 4px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 大批量列表「加载更多」 */
.list-more {
  padding: 6px 0 2px;
  display: flex;
  justify-content: center;
}
.list-more-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 18px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
  color: var(--text-dim);
  font-size: 13px;
  cursor: pointer;
  transition: all var(--dur) var(--ease);
  &:hover {
    color: var(--accent);
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }
}

.row {
  position: relative;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 10px 12px;
  transition: background var(--dur) var(--ease), transform var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);

  &:hover {
    background: var(--panel-2);
    transform: translateY(-2px);
    border-color: var(--border-strong);
    box-shadow: var(--shadow-md);
  }

  &.playing {
    border-color: var(--accent);
    box-shadow: 0 0 0 1px var(--accent-soft), 0 8px 24px var(--accent-glow);
  }
  &.replaced {
    border-color: rgba(127, 209, 160, 0.35);
  }
  &.drag-over {
    border-color: var(--accent);
    background: var(--accent-soft);
    box-shadow: 0 0 0 2px var(--accent-glow) inset;
    animation: pulse 1.2s ease-in-out infinite;
  }
}

.row-drop-hint {
  position: absolute;
  inset: 0;
  border-radius: var(--radius);
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: #fff;
  background: color-mix(in srgb, var(--accent) 35%, transparent);
  backdrop-filter: blur(2px);
  pointer-events: none;
  z-index: 2;
}

.row-main {
  display: flex;
  align-items: center;
  gap: 12px;
}

/* 播放按钮 */
.play {
  flex-shrink: 0;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 1px solid var(--border-strong);
  background: var(--accent);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 17px;
  transition: transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease),
    background var(--dur) var(--ease);

  &:hover {
    transform: scale(1.1);
    box-shadow: 0 6px 20px var(--accent-glow);
  }
  &.playing {
    background: var(--danger);
    box-shadow: 0 0 0 4px rgba(232, 87, 79, 0.2), 0 6px 20px rgba(232, 87, 79, 0.4);
  }
}

/* 均衡器动画 */
.eq {
  flex-shrink: 0;
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 18px;
  width: 20px;

  span {
    width: 3px;
    border-radius: 2px;
    background: var(--accent);
    height: 4px;
    transition: background var(--dur) var(--ease);
  }
  &.on span {
    animation: eqBar 0.9s ease-in-out infinite;
    background: var(--accent-2);
    &:nth-child(1) { animation-delay: 0s; }
    &:nth-child(2) { animation-delay: 0.2s; }
    &:nth-child(3) { animation-delay: 0.4s; }
    &:nth-child(4) { animation-delay: 0.1s; }
  }
}

.info {
  flex: 1;
  min-width: 0;
}
.name {
  font-size: 13px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 5px;
}
.tag {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--panel-3);
  color: var(--text-dim);
  border: 1px solid var(--border);

  &.replaced {
    background: rgba(127, 209, 160, 0.16);
    color: var(--ok);
    border-color: rgba(127, 209, 160, 0.3);
  }
}

.row-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.icon-btn {
  width: 30px;
  height: 30px;
  border-radius: 8px;
  border: 1px solid var(--border);
  background: var(--panel-3);
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 15px;
  transition: all var(--dur) var(--ease);
  &:hover {
    color: var(--ok);
    border-color: rgba(127, 209, 160, 0.5);
    background: rgba(127, 209, 160, 0.12);
  }
}
.replace {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  gap: 5px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: var(--panel-3);
  color: var(--text-dim);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  cursor: pointer;
  transition: background var(--dur) var(--ease), color var(--dur) var(--ease),
    border-color var(--dur) var(--ease), box-shadow var(--dur) var(--ease);

  &:hover {
    background: var(--accent-soft);
    border-color: var(--accent);
    color: var(--accent);
    box-shadow: 0 4px 14px var(--accent-glow);
  }
}

.idx {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* audio 控件换肤 */
.audio {
  display: none;
}

/* ---------- 统一播放条 ---------- */
.player {
  position: sticky;
  bottom: 0;
  z-index: 12;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 16px;
  margin: 0 12px 12px;
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  background: color-mix(in srgb, var(--panel-2) 82%, transparent);
  backdrop-filter: blur(14px);
  box-shadow: 0 -6px 24px var(--shadow-lg), 0 0 18px var(--accent-glow);
  animation: slideUp 0.3s var(--ease);

  .player-left {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-shrink: 0;
  }
  .player-info {
    flex-shrink: 0;
    min-width: 0;
    max-width: 26%;
    .player-name {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  }
  .player-center {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 10px;
    min-width: 0;
    .player-time {
      font-size: 11px;
      color: var(--text-dim);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .player-seek {
      flex: 1;
      min-width: 0;
      accent-color: var(--accent);
      cursor: pointer;
    }
  }
  .player-btn {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--panel-3);
    color: var(--text-dim);
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 14px;
    transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease),
      transform var(--dur) var(--ease), box-shadow var(--dur) var(--ease);
    &:hover {
      color: var(--accent);
      border-color: var(--accent);
      transform: scale(1.08);
    }
    &.primary {
      width: 40px;
      height: 40px;
      color: var(--accent);
      border-color: var(--accent);
      box-shadow: 0 0 12px var(--accent-glow);
    }
  }
}

.is-loading {
  animation: spin 1s linear infinite;
}

/* ---------- 动画 ---------- */
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
@keyframes breathe {
  0%, 100% { transform: scale(1); opacity: 0.85; }
  50% { transform: scale(1.15); opacity: 1; }
}
@keyframes wave {
  0%, 100% { transform: scaleY(0.5); }
  50% { transform: scaleY(1); }
}
@keyframes eqBar {
  0%, 100% { height: 4px; }
  50% { height: 18px; }
}
@keyframes pulse {
  0%, 100% { box-shadow: 0 0 0 2px var(--accent-glow) inset; }
  50% { box-shadow: 0 0 0 4px var(--accent-glow) inset; }
}
@keyframes slideIn {
  from { opacity: 0; transform: translateY(-6px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes slideUp {
  from { opacity: 0; transform: translateY(16px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 角色 ↔ 音频库 对照查询 */
.char-search {
  position: relative;
  display: flex;
  align-items: center;
  margin-bottom: 12px;
}
.char-search-icon {
  position: absolute;
  left: 12px;
  font-size: 16px;
  color: var(--text-third, #8a8f98);
  pointer-events: none;
}
.char-search-input {
  width: 100%;
  padding: 9px 40px 9px 36px;
  border: 1px solid var(--border, rgba(148, 163, 184, 0.25));
  border-radius: 10px;
  background: var(--bg-soft, rgba(148, 163, 184, 0.08));
  color: var(--text-main, #e6edf3);
  font-size: 14px;
  outline: none;
  transition: border-color 0.25s, box-shadow 0.25s;
}
.char-search-input:focus {
  border-color: var(--accent, #4f7cff);
  box-shadow: 0 0 0 3px var(--accent-glow, rgba(79, 124, 255, 0.18));
}
.char-search-clear {
  position: absolute;
  right: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-third, #8a8f98);
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
}
.char-search-clear:hover {
  background: var(--bg-soft, rgba(148, 163, 184, 0.15));
  color: var(--text-main, #e6edf3);
}
.char-tip {
  padding: 28px 0;
  text-align: center;
  color: var(--text-third, #8a8f98);
  font-size: 13px;
}
.char-tip.empty { color: var(--danger, #f56c6c); }
.char-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 340px;
  overflow-y: auto;
}
.char-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 4px;
  border-bottom: 1px dashed var(--border, rgba(148, 163, 184, 0.14));
  animation: slideIn 0.25s ease both;
}
.char-item:last-child { border-bottom: none; }
.char-name {
  flex: 0 0 auto;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-main, #e6edf3);
}
.char-banks {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  justify-content: flex-end;
}
.char-bank {
  cursor: pointer;
  transition: transform 0.15s, box-shadow 0.2s;
}
.char-bank:hover {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px var(--accent-glow, rgba(79, 124, 255, 0.25));
}
.char-more {
  padding: 10px 0 2px;
  text-align: center;
  font-size: 12px;
  color: var(--text-third, #8a8f98);
}

/* ---------- 移动端适配 ---------- */
@media (max-width: 720px) {
  .bank-studio {
    overflow-y: auto;
  }

  /* 顶栏：改纵向堆叠，避免按钮溢出 */
  .bar {
    position: static;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    padding: 10px 12px;

    .bar-left {
      flex-wrap: wrap;
      gap: 6px;
      .bar-file {
        max-width: 100%;
      }
    }
    .bar-right {
      flex-wrap: wrap;
      gap: 8px;
      .el-select {
        width: 100% !important;
        flex: 1 1 100%;
      }
      .el-button {
        flex: 1 1 auto;
        margin-left: 0 !important;
      }
      .bar-theme-btn.el-button {
        flex: 0 0 auto !important;
        width: 32px;
      }
    }
  }

  /* 搜索框：占满整行，计数提示弱化 */
  .toolbar {
    padding: 10px 12px 4px;
  }
  .search {
    max-width: none;
  }
  .count-hint {
    font-size: 11px;
  }

  /* 提示条 */
  .hint {
    padding: 6px 12px;
  }

  /* 列表：移动端取消内部独立滚动，随页面一起滚动；底部预留播放条高度避免遮挡 */
  .list {
    flex: none;
    overflow: visible;
    height: auto;
    padding: 4px 10px 84px;
  }
  .row {
    padding: 8px 10px;
  }
  .row-main {
    gap: 8px;
  }
  /* 窄屏隐藏均衡器动画，为名称与操作按钮腾空间 */
  .eq {
    display: none;
  }
  .icon-btn {
    width: 30px;
    height: 30px;
  }

  /* 空态 */
  .empty {
    margin: 10px;
    padding: 16px;
    h2 {
      font-size: 22px;
    }
    p {
      font-size: 13px;
    }
    .empty-hint {
      font-size: 12px;
    }
  }

  /* 角色对照弹窗：卡片项纵向排列，标签换行 */
  .char-item {
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .char-banks {
    justify-content: flex-start;
  }

  /* 播放条：窄屏紧凑布局，名称换到独立一行，避免挤压进度条 */
  .player {
    position: sticky;
    bottom: 0;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 12px;
    margin: 0 8px 8px;
    .player-info {
      order: 0;
      flex: 1 1 100%;
      max-width: 100%;
      .player-name {
        font-size: 12px;
      }
    }
    .player-left {
      order: 1;
    }
    .player-center {
      order: 2;
      flex: 1 1 auto;
      gap: 6px;
    }
    .player-btn.close-btn {
      order: 3;
    }
  }
}

/* ---------- 匹配原格式开关 ---------- */
.match-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-dim);
  .match-label {
    white-space: nowrap;
  }
}

/* ---------- 导出自检条 ---------- */
.selfcheck {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  animation: slideIn var(--dur) var(--ease);
  &.ok {
    color: var(--ok);
    background: rgba(127, 209, 160, 0.08);
  }
  &.warn {
    color: var(--warn, #e6a23c);
    background: rgba(230, 162, 60, 0.1);
  }
  .el-icon {
    font-size: 15px;
  }
}

/* ---------- 样本详情抽屉 ---------- */
.detail {
  display: flex;
  flex-direction: column;
  gap: 18px;

  .detail-block {
    animation: slideIn var(--dur) var(--ease);
  }
  .detail-h {
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
    margin-bottom: 8px;
  }
  .detail-tbl {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
    td {
      padding: 6px 8px;
      border-bottom: 1px solid var(--border);
      &:first-child {
        color: var(--text-faint);
        width: 84px;
        white-space: nowrap;
      }
      &:last-child {
        color: var(--text);
        font-variant-numeric: tabular-nums;
        word-break: break-all;
      }
    }
  }

  .ab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .ab-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 6px;
  }
  .ab-play {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 1px solid var(--border-strong);
    background: var(--accent);
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 14px;
    transition: box-shadow var(--dur) var(--ease), transform var(--dur) var(--ease);
    &:hover {
      box-shadow: 0 4px 14px var(--accent-glow);
      transform: scale(1.08);
    }
  }
  .wave-canvas {
    width: 100%;
    height: 64px;
    border-radius: var(--radius-sm);
    background: var(--panel-2);
    border: 1px solid var(--border);
    display: block;
  }
  .wave-tip {
    font-size: 11px;
    color: var(--text-faint);
    margin-top: 4px;
  }
  .detail-note {
    font-size: 11px;
    color: var(--text-faint);
    line-height: 1.6;
    margin: 4px 0 0;
  }
}

/* tag 变体（格式提示） */
.tag.converted {
  background: rgba(79, 124, 255, 0.16);
  color: var(--accent);
  border-color: rgba(79, 124, 255, 0.3);
}
.tag.raw {
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.3);
}
/* 时长对比标签 */
.tag.duration-diff {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.2px;
}
.tag.duration-diff.longer {
  background: rgba(244, 63, 94, 0.14);
  color: #fb7185;
  border-color: rgba(244, 63, 94, 0.3);
}
.tag.duration-diff.shorter {
  background: rgba(52, 211, 153, 0.14);
  color: #34d399;
  border-color: rgba(52, 211, 153, 0.3);
}
</style>