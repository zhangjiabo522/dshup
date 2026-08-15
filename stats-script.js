// stats-script.js
// 会话统计聚合脚本：由客户端主进程用系统 Node（>=22.15，内置 node:zlib zstd）运行。
// 扫描 $DSH_HOME/sessions/**/session.jsonl.zstd（多独立 zstd frame 拼接），
// 聚合：总 token、今日 token、最长任务完成时间、近 3 个月每日 token 用量。
//
// 性能设计（增量缓存）：每个会话文件的聚合结果按 (size, mtimeMs) 记入
// %LOCALAPPDATA%\DeepSeekHarnessClient\stats-cache.json；文件未变化时直接复用，
// 只解码新增/变化的文件 —— 稳定使用后单次扫描从"全量 zstd 解码几十秒"
// 降到几百毫秒。完整结果同时写 stats-snapshot.json 供界面秒开。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { zstdDecompressSync } = require('node:zlib');

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const root = path.join(home, 'sessions');
const clientBase = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarnessClient')
  : path.join(os.homedir(), 'Library', 'Application Support', 'DeepSeekHarnessClient');
const CACHE_FILE = path.join(clientBase, 'stats-cache.json');
const SNAPSHOT_FILE = path.join(clientBase, 'stats-snapshot.json');
const MAX_CACHE_FILES = 5000; // 缓存条目上限保护：超过即整体重建，防止膨胀
const MAGIC = [0x28, 0xb5, 0x2f, 0xfd]; // ZSTD magic 0xFD2FB528 (LE)

const pad = (n) => String(n).padStart(2, '0');
const localDayKey = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const todayKey = localDayKey(Date.now());

function usageTokens(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  return (
    (Number(usage.inputTokens) || 0) +
    (Number(usage.outputTokens) || 0) +
    (Number(usage.reasoningTokens) || 0)
  );
}

function scanFrames(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) {
      starts.push(i);
    }
  }
  return starts;
}

/** 读取增量缓存（不存在/损坏 → 空）。 */
function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    return c && typeof c === 'object' && c.files && typeof c.files === 'object' ? c : { files: {} };
  } catch (e) {
    return { files: {} };
  }
}

/** 原子写 JSON（tmp + rename，避免半截写坏缓存）。 */
function writeJsonAtomic(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  } catch (e) {
    /* 缓存写失败不影响本次返回 */
  }
}

/**
 * 完整解码一个会话文件，返回该文件的聚合分片。
 * @returns {object|null} 分片；文件无有效 frame 时返回 null
 */
function scanSessionFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return null;
  }
  const starts = scanFrames(buf);
  if (starts.length === 0) return null;
  const p = {
    session: true,
    tokens: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    daily: {},
    turns: 0,
    longestTurnMs: 0,
    longestSessionMs: 0,
  };
  let firstTime = null;
  let lastTime = null;
  const turnStart = new Map();
  for (let k = 0; k < starts.length; k++) {
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    let text;
    try {
      text = zstdDecompressSync(buf.subarray(starts[k], end)).toString('utf8');
    } catch (e) {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch (e) {
        continue;
      }
      if (typeof ev.time === 'number') {
        if (firstTime === null || ev.time < firstTime) firstTime = ev.time;
        if (lastTime === null || ev.time > lastTime) lastTime = ev.time;
      }
      if (ev.type === 'turn/start' && ev.data && typeof ev.data.turn === 'number') {
        turnStart.set(ev.data.turn, ev.time);
        p.turns++;
      } else if (ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') {
        const start = turnStart.get(ev.data.turn);
        const completed = ev.data.reason && ev.data.reason.kind === 'completed';
        if (start !== undefined && completed) {
          const span = ev.time - start;
          if (span > p.longestTurnMs) p.longestTurnMs = span;
        }
      }
      const usage = ev.data && ev.data.usage;
      if (ev.type === 'assistant/message' && usage) {
        const tokens = usageTokens(usage);
        if (tokens <= 0) continue;
        p.tokens += tokens;
        p.input += Number(usage.inputTokens) || 0;
        p.output += Number(usage.outputTokens) || 0;
        p.reasoning += Number(usage.reasoningTokens) || 0;
        const key = localDayKey(ev.time);
        p.daily[key] = (p.daily[key] || 0) + tokens;
      }
    }
  }
  if (firstTime !== null && lastTime !== null) p.longestSessionMs = lastTime - firstTime;
  return p;
}

/** 收集全部会话文件路径。 */
function collectFiles() {
  const files = [];
  (function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl.zstd')) files.push(p);
    }
  })(root);
  return files;
}

/** 把一个文件的分片合并进全局聚合。 */
function mergeInto(agg, p, file) {
  agg.totalTokens += p.tokens;
  agg.totalInputTokens += p.input;
  agg.totalOutputTokens += p.output;
  agg.totalReasoningTokens += p.reasoning;
  agg.turnCount += p.turns;
  if (p.session) agg.sessionCount++;
  for (const key of Object.keys(p.daily)) {
    agg.daily[key] = (agg.daily[key] || 0) + p.daily[key];
  }
  if (p.longestTurnMs > agg.longestTaskMs) {
    agg.longestTaskMs = p.longestTurnMs;
    agg.longestTaskId = path.basename(path.dirname(file));
  }
  if (p.longestSessionMs > agg.longestSessionMs) {
    agg.longestSessionMs = p.longestSessionMs;
    agg.longestSessionId = path.basename(path.dirname(file));
  }
}

if (!fs.existsSync(root)) {
  console.log(JSON.stringify({ available: false, reason: 'no-sessions-dir' }));
  process.exit(0);
}

const cache = loadCache();
const files = collectFiles();
if (Object.keys(cache.files).length > MAX_CACHE_FILES) cache.files = {};

const agg = {
  totalTokens: 0,
  todayTokens: 0,
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalReasoningTokens: 0,
  longestTaskMs: 0,
  longestTaskId: '',
  turnCount: 0,
  sessionCount: 0,
  longestSessionMs: 0,
  longestSessionId: '',
  daily: {},
};
const nextFiles = {};

for (const file of files) {
  let st;
  try {
    st = fs.statSync(file);
  } catch (e) {
    continue;
  }
  const cached = cache.files[file];
  let p = null;
  if (cached && cached.ok && cached.size === st.size && cached.mtimeMs === st.mtimeMs) {
    p = cached; // 未变化：复用缓存分片，跳过 zstd 解码
  } else {
    p = scanSessionFile(file);
  }
  if (p === null) continue;
  nextFiles[file] = {
    ok: true,
    size: st.size,
    mtimeMs: st.mtimeMs,
    tokens: p.tokens,
    input: p.input,
    output: p.output,
    reasoning: p.reasoning,
    daily: p.daily,
    turns: p.turns,
    longestTurnMs: p.longestTurnMs,
    longestSessionMs: p.longestSessionMs,
    session: p.session === true,
  };
  mergeInto(agg, p, file);
}

agg.todayTokens = agg.daily[todayKey] || 0;
writeJsonAtomic(CACHE_FILE, { files: nextFiles });

const out = { available: true, ...agg };
writeJsonAtomic(SNAPSHOT_FILE, out);
console.log(JSON.stringify(out));
