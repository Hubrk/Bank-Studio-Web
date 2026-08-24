import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync('C:/Users/34072/Desktop/BankStudioWeb/scripts/clean_char_banks.json', 'utf8'));

// 按名称聚合，收集去重后的 bank 集合
const byName = new Map();
for (const r of rows) {
  if (!byName.has(r.name)) byName.set(r.name, new Set());
  byName.get(r.name).add(r.bank);
}

// 清洗规则：有真实 bank 时丢弃“无”；仅当没有任何真实 bank 才标记为无
const out = [];
for (const [name, set] of byName) {
  const real = [...set].filter((b) => b !== '无').sort((a, b) => a.localeCompare(b));
  if (real.length > 0) {
    out.push({ name, banks: real });
  }
  // 没有任何可对应音频库的角色直接丢弃，不保留
}
out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

const withBank = out.length;
console.log(`唯一角色: ${out.length} | 有bank: ${withBank}（已丢弃无bank的角色）`);

let ts = `// 由 scripts/clean_char_banks.mjs + gen_char_banks_ts.mjs 生成，勿手改
export interface CharBankLookup {
  /** 角色名 */
  name: string;
  /** 对应音频库（去重后）；空数组表示该角色暂无可用音频库 */
  banks: string[];
}

export const CHAR_BANKS: CharBankLookup[] = ${JSON.stringify(out, null, 0)};\n`;
writeFileSync('C:/Users/34072/Desktop/BankStudioWeb/src/data/charBanks.ts', ts, 'utf8');
console.log('已写出 src/data/charBanks.ts');