import { readFileSync, writeFileSync } from 'node:fs';

const raw = readFileSync('C:/Users/34072/Desktop/BankStudioWeb/火影Bank文件对照表..txt', 'utf8');
const lines = raw.split(/\r?\n/);

const entries = [];
let pendingName = null;
for (const line of lines) {
  const t = line.trim();
  const m = t.match(/^名称:\s*'?(.*?)'?$/);
  if (m) { pendingName = m[1].trim(); continue; }
  const b = t.match(/^音频库名称:\s*(.*)$/);
  if (b && pendingName != null) {
    entries.push({ name: pendingName, bank: b[1].trim() || '无' });
    pendingName = null;
  }
}

// 完全去重（保留首次出现）
const seen = new Set();
const dedup = [];
for (const e of entries) {
  const key = `${e.name}\u0000${e.bank}`;
  if (!seen.has(key)) { seen.add(key); dedup.push(e); }
}

// 同名是否映射到多个不同 bank（非无）
const byName = new Map();
for (const e of dedup) {
  if (!byName.has(e.name)) byName.set(e.name, new Set());
  byName.get(e.name).add(e.bank);
}
const multiBank = [...byName.entries()].filter(([, s]) => s.size > 1);

const stats = {
  rawLines: lines.length,
  rawEntries: entries.length,
  dedupEntries: dedup.length,
  withBank: dedup.filter((e) => e.bank !== '无').length,
  noBank: dedup.filter((e) => e.bank === '无').length,
  uniqueNames: byName.size,
  multiBankNames: multiBank.map(([n, s]) => `${n} -> ${[...s].join(' | ')}`),
};

console.log(JSON.stringify(stats, null, 2));

// 前若干个多映射抽样
console.log('\n--- 多 bank 名称抽样 ---');
console.log(multiBank.slice(0, 30).map(([n, s]) => `${n}: ${[...s].join(' | ')}`).join('\n'));

// 输出干净 JSON（按名称排序）
dedup.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
writeFileSync('C:/Users/34072/Desktop/BankStudioWeb/scripts/clean_char_banks.json', JSON.stringify(dedup, null, 0), 'utf8');
console.log('\n已写出 clean_char_banks.json, 共', dedup.length, '条');