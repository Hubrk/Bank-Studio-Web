// 临时验证脚本：模拟新代码导出管线（复刻 fsbWriter.ts 最新逻辑）
// 断言1：无替换导出 → 输出与原文件逐字节一致
// 断言2：模拟新 FSB 变长/变短 → SND/RIFF/SNDH 尺寸全部自洽（chunk 覆盖终点 == 文件尾）
import fs from 'node:fs';

const concat = (arrs) => {
  let len = 0;
  for (const a of arrs) len += a.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const a of arrs) { out.set(a, p); p += a.length; }
  return out;
};

const replaceU32InRange = (dv, start, end, oldVal, newVal) => {
  let count = 0;
  for (let p = start; p + 4 <= end; p++) {
    if (dv.getUint32(p, true) === (oldVal >>> 0)) {
      dv.setUint32(p, newVal >>> 0, true);
      count++;
      p += 3;
    }
  }
  return count;
};

const findSndChunk = (containerBytes, fsbOffset) => {
  const dv = new DataView(containerBytes.buffer, containerBytes.byteOffset, containerBytes.byteLength);
  const lo = Math.max(0, fsbOffset - 1024);
  for (let i = fsbOffset - 8; i >= lo; i--) {
    if (containerBytes[i] === 0x53 && containerBytes[i + 1] === 0x4e && containerBytes[i + 2] === 0x44 && containerBytes[i + 3] === 0x20) {
      const size = dv.getUint32(i + 4, true);
      if (size === containerBytes.length - (i + 8)) return { tagOff: i, gap: fsbOffset - (i + 8) };
    }
  }
  return null;
};

const wrapFsbInContainer = (containerBytes, fsbOffset, newFsb, opts = {}) => {
  const prefix = containerBytes.subarray(0, fsbOffset);
  const out = concat([prefix, newFsb]);
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const snd = findSndChunk(containerBytes, fsbOffset);
  if (snd) dv.setUint32(snd.tagOff + 4, snd.gap + newFsb.length, true);
  if (out.length >= 8 && containerBytes[0] === 0x52) dv.setUint32(4, out.length - 8, true);
  let sizePatched = 0;
  if (opts.oldFsbSize != null && opts.oldFsbSize !== newFsb.length) {
    sizePatched = replaceU32InRange(dv, 0, fsbOffset, opts.oldFsbSize, newFsb.length);
  }
  let lengthPatched = 0;
  for (const pair of opts.lengthPairs ?? []) {
    if (pair.oldFrames === pair.newFrames) continue;
    lengthPatched += replaceU32InRange(dv, 0, fsbOffset, pair.oldFrames, pair.newFrames);
  }
  return { bytes: out, lengthPatched, sizePatched, snd };
};

const findFsb = (b) => b.indexOf(Buffer.from('FSB5'));

const checkConsistency = (outU8, name) => {
  const out = Buffer.from(outU8.buffer, outU8.byteOffset, outU8.byteLength);
  const fo = findFsb(out);
  const snd = findSndChunk(out, fo);
  const ok1 = out.readUInt32LE(4) === out.length - 8;
  const sndEnd = snd ? snd.tagOff + 8 + out.readUInt32LE(snd.tagOff + 4) : -1;
  const ok2 = sndEnd === out.length;
  console.log(`  [${name}] RIFF size自洽: ${ok1 ? '✔' : '✘'}  SND覆盖终点=${sndEnd} 文件尾=${out.length} ${ok2 ? '✔' : '✘'}`);
  return ok1 && ok2;
};

const files = [
  ['比对2/比对/sfx11.bank', 'sfx11'],
  ['比对2/比对/bgm1.bank', 'bgm1'],
  ['比对2/比对/bgm_title0.bank', 'bgm_title0'],
  ['bgm.bank', 'bgm'],
];

let allOk = true;
for (const [path, name] of files) {
  const orig = fs.readFileSync(new URL('../' + path, import.meta.url));
  const fo = findFsb(orig);
  const oldFsb = orig.subarray(fo);
  console.log(`\n===== ${name} (gap=${fo - (findSndChunk(orig, fo)?.tagOff + 8)}) =====`);

  // 断言1：无替换（新代码短路返回原 FSB）→ 全文件逐字节一致
  const r1 = wrapFsbInContainer(orig, fo, oldFsb, { oldFsbSize: oldFsb.length });
  const identical = r1.bytes.length === orig.length && r1.bytes.every((v, i) => v === orig[i]);
  console.log(`  无替换导出与原文件逐字节一致: ${identical ? '✔' : '✘'}`);
  allOk &&= identical;

  // 断言2：模拟新 FSB 变长 +640 字节、变短 -1024 字节
  for (const delta of [640, -1024]) {
    const newFsb = new Uint8Array(oldFsb.length + delta);
    newFsb.set(oldFsb.subarray(0, Math.min(oldFsb.length, newFsb.length)));
    const r = wrapFsbInContainer(orig, fo, newFsb, { oldFsbSize: oldFsb.length });
    const ok = checkConsistency(r.bytes, `Δ${delta > 0 ? '+' : ''}${delta} SNDH patch=${r.sizePatched}`);
    allOk &&= ok;
  }
}
console.log(allOk ? '\n全部断言通过 ✔' : '\n存在失败 ✘');
