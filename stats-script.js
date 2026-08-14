// stats-script.js
// 会话统计聚合脚本：由客户端主进程用系统 Node（>=22.15，内置 node:zlib zstd）运行。
// 扫描 $DSH_HOME/sessions/**/session.jsonl.zstd（多独立 zstd frame 拼接），
// 聚合：总 token、今日 token、最长任务完成时间、近 3 个月每日 token 用量。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { zstdDecompressSync } = require('node:zlib');

const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const root = path.join(home, 'sessions');
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

const total = { tokens: 0, input: 0, output: 0, reasoning: 0 };
const today = { tokens: 0 };
const daily = new Map();
let longestTurnMs = 0; // 最长单轮任务（turn/start → turn/end，completed）的完成耗时
let longestTurnId = '';
let turnCount = 0;
let longestSessionMs = 0;
let longestSessionId = '';
let sessionCount = 0;

function processSession(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    return;
  }
  const starts = scanFrames(buf);
  if (starts.length === 0) return;
  sessionCount++;
  let firstTime = null;
  let lastTime = null;
  const turnStart = new Map(); // turn -> start time
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
        turnCount++;
      } else if (ev.type === 'turn/end' && ev.data && typeof ev.data.turn === 'number') {
        const start = turnStart.get(ev.data.turn);
        const completed = ev.data.reason && ev.data.reason.kind === 'completed';
        if (start !== undefined && completed) {
          const span = ev.time - start;
          if (span > longestTurnMs) {
            longestTurnMs = span;
            longestTurnId = path.basename(path.dirname(file));
          }
        }
      }
      const usage = ev.data && ev.data.usage;
      if (ev.type === 'assistant/message' && usage) {
        const tokens = usageTokens(usage);
        if (tokens <= 0) continue;
        total.tokens += tokens;
        total.input += Number(usage.inputTokens) || 0;
        total.output += Number(usage.outputTokens) || 0;
        total.reasoning += Number(usage.reasoningTokens) || 0;
        const key = localDayKey(ev.time);
        daily.set(key, (daily.get(key) || 0) + tokens);
        if (key === todayKey) today.tokens += tokens;
      }
    }
  }
  if (firstTime !== null && lastTime !== null) {
    const span = lastTime - firstTime;
    if (span > longestSessionMs) {
      longestSessionMs = span;
      longestSessionId = path.basename(path.dirname(file));
    }
  }
}

function walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p);
    else if (ent.name.endsWith('.jsonl.zstd')) processSession(p);
  }
}

if (!fs.existsSync(root)) {
  console.log(JSON.stringify({ available: false, reason: 'no-sessions-dir' }));
  process.exit(0);
}
walk(root);

console.log(
  JSON.stringify({
    available: true,
    totalTokens: total.tokens,
    todayTokens: today.tokens,
    totalInputTokens: total.input,
    totalOutputTokens: total.output,
    totalReasoningTokens: total.reasoning,
    longestTaskMs: longestTurnMs, // 最长单轮任务（turn）完成耗时
    longestTaskId: longestTurnId,
    turnCount,
    sessionCount,
    daily: Object.fromEntries(daily),
  })
);
