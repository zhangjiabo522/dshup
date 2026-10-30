// bootstrap.js
// DeepSeek Harness Windows 客户端 —— 环境检测 / 安装 / 启动逻辑（纯 Node，可脱离 Electron 单独测试）
//
// 设计原则：
//   1. 不破坏用户原有环境：所有自动安装的依赖（Node、pnpm、dsh）都放进私有目录
//      %LOCALAPPDATA%\DeepSeekHarnessClient\runtime，绝不写用户 PATH、注册表或 npm 全局。
//   2. 国内镜像：npm 包用 registry.npmmirror.com，Node 二进制用 npmmirror.com/mirrors/node。
//   3. 优先复用：系统已有且版本达标的 Node / pnpm 直接用；本地已有 dsh 源码仓库或已安装的 dsh 直接用。
//   4. 端口优先：3080 已在监听就直接返回，不重复启动。

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const http = require('http');
const net = require('net');
const tls = require('tls');

const PORT = process.env.DSH_PORT === undefined ? 3080 : Number(process.env.DSH_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error('DSH_PORT 必须是 1 到 65535 之间的整数');
}
const APP_URL = `http://127.0.0.1:${PORT}/`;
const NPM_MIRROR = 'https://registry.npmmirror.com';
const NPM_OFFICIAL = 'https://registry.npmjs.org';
const NODE_MIRROR = 'https://npmmirror.com/mirrors/node';
const NODE_OFFICIAL = 'https://nodejs.org/dist';
const NODE_LTS_MAJOR = 22; // 需要私有安装时使用的 LTS 大版本（npmmirror 镜像）
const PNPM_VERSION = '11.7.0'; // 与 deepseek-harness 仓库 packageManager 一致
const DSH_PACKAGE = '@deepseek-ai/dsh@0.2.1-rc.5';
const MIN_PRIVATE_DSH_VERSION = DSH_PACKAGE.slice(DSH_PACKAGE.lastIndexOf('@') + 1);
const MAX_POLL_MS = 180000; // 等待 dsh 启动的最长时间
const POLL_INTERVAL_MS = 1200;

// ---------------- 客户端设置感知（镜像源 / 网络模式） ----------------
// 设置文件与主进程共用：%LOCALAPPDATA%\DeepSeekHarnessClient\client-settings.json
// （macOS：~/Library/Application Support/DeepSeekHarnessClient/client-settings.json）
// （Linux：$XDG_DATA_HOME/DeepSeekHarnessClient 或 ~/.local/share/DeepSeekHarnessClient）

function clientBaseDir() {
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarnessClient');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'DeepSeekHarnessClient');
  }
  const configuredDataHome = process.env.XDG_DATA_HOME;
  const dataHome = configuredDataHome && path.isAbsolute(configuredDataHome)
    ? configuredDataHome
    : path.join(os.homedir(), '.local', 'share');
  return path.join(dataHome, 'DeepSeekHarnessClient');
}

function clientSettingsFile() {
  return path.join(clientBaseDir(), 'client-settings.json');
}

function readClientSettings() {
  try {
    const data = JSON.parse(fs.readFileSync(clientSettingsFile(), 'utf8'));
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    return {};
  }
}

/** 当前下载镜像：官方源 / 国内镜像（npmmirror）。 */
function mirrors() {
  if (readClientSettings().mirror === 'official') {
    return { npm: NPM_OFFICIAL, node: NODE_OFFICIAL };
  }
  return { npm: NPM_MIRROR, node: NODE_MIRROR };
}

/** 网络模式：direct（直连，跳过系统代理）或 auto（自动检测系统代理）。 */
function proxyAllowed() {
  return readClientSettings().proxyMode !== 'direct';
}

// 平台分支：Windows（cmd/where/注册表）、macOS（sh/which/launchd）、Linux（sh/which/XDG）
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';
const IS_LINUX = process.platform === 'linux';

// 已知的本地源码仓库候选（先于 npm 安装复用；可用 DSH_CHECKOUT 环境变量覆盖）
const CHECKOUT_CANDIDATES = () => {
  const list = [];
  if (process.env.DSH_CHECKOUT) list.push(process.env.DSH_CHECKOUT);
  list.push(
    path.join(os.homedir(), 'deepseek-harness'),
    path.join(os.homedir(), 'DeepSeek-Harness'),
  );
  if (IS_WIN) list.push('C:\\Users\\zjb\\deepseek-harness');
  return list;
};

function runtimeDir() {
  return path.join(clientBaseDir(), 'runtime');
}

// ---------------- 事件 ----------------

function createEmitter(onEvent) {
  return (type, data) => {
    const msg = data && typeof data === 'string' ? data : (data && data.message) || '';
    const payload = { type, message: msg, ...(data && typeof data === 'object' ? data : {}) };
    try {
      onEvent && onEvent(payload);
    } catch (e) {
      /* 忽略渲染层异常 */
    }
    if (type === 'log') console.log('[bootstrap]', msg);
    if (type === 'error') console.error('[bootstrap][error]', msg);
  };
}

// ---------------- 通用工具 ----------------

function fail(msg) {
  throw new Error(msg);
}

// cmd.exe 绝对路径：开机自启等场景 PATH 可能不完整（甚至不含 System32），
// 一律用 ComSpec / SystemRoot 解析，绝不依赖 PATH 查找。
function resolveCmd() {
  const candidates = [
    process.env.ComSpec,
    process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'cmd.exe') : null,
    'C:\\Windows\\System32\\cmd.exe',
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'cmd.exe'; // 兜底：仍走 PATH
}

// 保证子进程 PATH 至少含 System32（自启场景 PATH 可能残缺）
function withSanePath(env) {
  const merged = { ...env };
  const system32 = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : 'C:\\Windows\\System32';
  if (typeof merged.PATH === 'string' && merged.PATH.length > 0) {
    if (!merged.PATH.split(path.delimiter).some(p => p.toLowerCase() === system32.toLowerCase())) {
      merged.PATH = system32 + path.delimiter + merged.PATH;
    }
  } else {
    merged.PATH = system32;
  }
  return merged;
}

/** 把私有 Node / dsh bin 放到 PATH 最前：shebang（#!/usr/bin/env node）和 dsh 子进程都能找到正确版本。 */
function withRuntimePath(env, nodeExe) {
  const merged = IS_WIN ? withSanePath(env || process.env) : { ...(env || process.env) };
  const extras = [];
  if (nodeExe) extras.push(path.dirname(nodeExe));
  extras.push(path.join(runtimeDir(), 'node_modules', '.bin'));
  const current = merged.PATH || '';
  const parts = extras.concat(current.split(path.delimiter).filter(Boolean), IS_WIN ? [] : ['/usr/local/bin', '/usr/bin', '/bin']);
  const seen = new Set();
  merged.PATH = parts.filter((p) => {
    const key = IS_WIN ? p.toLowerCase() : p;
    if (!p || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).join(path.delimiter);
  return merged;
}

function runCmd(command, opts = {}) {
  const { cwd, env, timeout } = opts;
  if (IS_WIN) {
    // Windows：通过临时 .cmd 文件执行（cmd 引号解析可靠）
    const bat = path.join(os.tmpdir(), `dsh-cmd-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.cmd`);
    fs.writeFileSync(bat, '@echo off\r\n' + command + '\r\nexit /b %errorlevel%\r\n', 'utf8');
    try {
      const res = spawnSync(resolveCmd(), ['/d', '/c', `"${bat}"`], {
        cwd: cwd || process.cwd(),
        env: withSanePath(env || process.env),
        encoding: 'utf8',
        timeout: timeout || 120000,
        windowsHide: true,
        windowsVerbatimArguments: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
    } finally {
      try { fs.unlinkSync(bat); } catch (e) { /* ignore */ }
    }
  }
  // macOS / 其他：/bin/sh -c
  const res = spawnSync('/bin/sh', ['-c', command], {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    encoding: 'utf8',
    timeout: timeout || 120000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function runExe(exe, args, opts = {}) {
  // 直接以参数数组方式调用可执行文件，避免 cmd 引号转义问题
  const { cwd, env, timeout } = opts;
  const res = spawnSync(exe, args, {
    cwd: cwd || process.cwd(),
    env: env || process.env,
    encoding: 'utf8',
    timeout: timeout || 30000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** 输出行 → 进度回调（节流：每秒最多一条，只转发关键行）。 */
function progressRelay(forward) {
  let last = 0;
  return line => {
    const now = Date.now();
    if (now - last < 1000) return;
    last = now;
    if (/Downloading|Collecting|Installing|added|added \d+ packages|Building|Successfully|ERROR|error|reify|idealTree/i.test(line)) {
      forward(line);
    }
  };
}

/**
 * 异步执行命令（不阻塞事件循环）：长操作（npm 安装/解压）必须用它，
 * 否则 spawnSync 会让 Electron 主进程数分钟无响应（新环境首启卡死的根因）。
 * @param {object} opts
 * @param {(line:string)=>void} [opts.onLine] 输出行回调（实时进度）
 * @returns {Promise<{status:number, stdout:string, stderr:string}>}
 */
function runCmdAsync(command, opts = {}) {
  return new Promise((resolve, reject) => {
    const { cwd, env, timeout, onLine } = opts;
    let child;
    let bat = null;
    if (IS_WIN) {
      bat = path.join(os.tmpdir(), `dsh-async-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.cmd`);
      fs.writeFileSync(bat, '@echo off\r\n' + command + '\r\nexit /b %errorlevel%\r\n', 'utf8');
      child = spawn(resolveCmd(), ['/d', '/c', `"${bat}"`], {
        cwd: cwd || process.cwd(),
        env: withSanePath(env || process.env),
        windowsHide: true,
        windowsVerbatimArguments: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      child = spawn('/bin/sh', ['-c', command], {
        cwd: cwd || process.cwd(),
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (!IS_WIN && child.pid) {
          try { process.kill(-child.pid, 'SIGTERM'); } catch (e1) { child.kill(); }
        } else {
          child.kill();
        }
      } catch (e) { /* ignore */ }
    }, timeout || 600000);
    child.stdout.on('data', (d) => {
      const text = d.toString('utf8');
      stdout += text;
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim() !== '') onLine(line.trim());
    });
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8');
      stderr += text;
      if (onLine) for (const line of text.split(/\r?\n/)) if (line.trim() !== '') onLine(line.trim());
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (bat !== null) {
        try { fs.unlinkSync(bat); } catch (e) { /* ignore */ }
      }
      if (timedOut) reject(new Error(`命令超时（${Math.round((timeout || 600000) / 60000)} 分钟）: ${command.slice(0, 80)}`));
      else if (code === 0) resolve({ status: 0, stdout, stderr });
      else reject(new Error(`命令失败（exit ${code}）: ${(stderr || stdout).split(/\r?\n/).filter(Boolean).slice(-6).join(' | ').slice(0, 500)}`));
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      if (bat !== null) {
        try { fs.unlinkSync(bat); } catch (e2) { /* ignore */ }
      }
      reject(new Error('无法启动命令: ' + e.message));
    });
  });
}

// ---------------- 网络（系统代理感知，兼容 Clash 等代理工具的 fake-IP DNS） ----------------

function detectProxy() {
  // 1) 环境变量
  const envs = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  for (const k of envs) {
    const v = process.env[k];
    if (v && /^https?:\/\//i.test(v.trim())) return v.trim();
  }
  // 2) Windows 系统代理（WinINET）
  try {
    const r1 = runExe('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyEnable'], { timeout: 8000 });
    if (r1.status !== 0 || !/0x1\b/.test(r1.stdout)) return null;
    const r2 = runExe('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', '/v', 'ProxyServer'], { timeout: 8000 });
    const m = /ProxyServer\s+REG_SZ\s+(.+)$/m.exec(r2.stdout);
    if (!m) return null;
    let srv = m[1].trim();
    // 处理 "http=127.0.0.1:7890;https=127.0.0.1:7890" 形式
    if (srv.includes('=')) {
      const parts = srv.split(';').map((x) => x.trim());
      const httpsPart = parts.find((x) => /^https=/i.test(x));
      const anyPart = parts.find((x) => /^https?=/i.test(x)) || parts[0];
      srv = (httpsPart || anyPart).split('=')[1];
    }
    if (!srv) return null;
    return 'http://' + srv.replace(/^https?:\/\//i, '');
  } catch (e) {
    return null;
  }
}

function proxyArgs() {
  if (!proxyAllowed()) return '';
  const p = detectProxy();
  return p ? ` --proxy="${p}" --https-proxy="${p}"` : '';
}

function connectTunnel(proxyHost, proxyPort, targetHost, targetPort) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxyHost, port: proxyPort });
    socket.setTimeout(20000, () => socket.destroy(new Error('代理 CONNECT 超时')));
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nProxy-Connection: keep-alive\r\n\r\n`
      );
    });
    let buf = '';
    socket.on('data', (d) => {
      buf += d.toString('latin1');
      const i = buf.indexOf('\r\n\r\n');
      if (i >= 0) {
        const head = buf.slice(0, i);
        if (/^HTTP\/1\.[01]\s+200\b/.test(head)) {
          socket.removeAllListeners('data');
          socket.setTimeout(0);
          resolve(socket);
        } else {
          socket.destroy();
          reject(new Error('代理拒绝连接: ' + head.split('\r\n')[0]));
        }
      }
    });
    socket.on('error', reject);
  });
}

function requestOnce(url, opts, useProxy) {
  // opts: { method?, headers? }；返回响应对象（流）
  const u = new URL(url);
  const isHttps = u.protocol === 'https:';
  const headers = opts.headers || {};
  const method = opts.method || 'GET';

  if (!useProxy) {
    const mod = isHttps ? https : http;
    return new Promise((resolve, reject) => {
      const req = mod.request(url, { method, headers }, (res) => resolve(res));
      req.on('error', reject);
      req.setTimeout(30000, () => req.destroy(new Error('请求超时: ' + url)));
      req.end();
    });
  }

  // 走代理：https 用 CONNECT 隧道 + TLS；http 用绝对形式请求
  return new Promise((resolve, reject) => {
    const pu = new URL(useProxy);
    const ph = pu.hostname;
    const pp = parseInt(pu.port || '80', 10);
    if (!isHttps) {
      const req = http.request({ host: ph, port: pp, path: url, method, headers }, (res) => resolve(res));
      req.on('error', reject);
      req.end();
      return;
    }
    (async () => {
      try {
        const raw = await connectTunnel(ph, pp, u.hostname, 443);
        const tlsSocket = tls.connect({ socket: raw, servername: u.hostname });
        tlsSocket.once('secureConnect', () => {
          const req = http.request(
            { createConnection: () => tlsSocket, host: u.hostname, port: 443, path: u.pathname + u.search, method, headers },
            (res) => resolve(res)
          );
          req.on('error', reject);
          req.end();
        });
        tlsSocket.on('error', reject);
      } catch (e) {
        reject(e);
      }
    })();
  });
}

async function requestFollowRedirects(url, opts, useProxy, maxRedirects = 5) {
  let cur = url;
  for (let i = 0; i <= maxRedirects; i++) {
    const res = await requestOnce(cur, opts, useProxy);
    if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      cur = new URL(res.headers.location, cur).toString();
      continue;
    }
    return { res, finalUrl: cur };
  }
  throw new Error('重定向次数过多: ' + url);
}

async function download(url, dest, emit) {
  const proxy = proxyAllowed() ? detectProxy() : null;
  const attempts = proxy ? [proxy, null] : [null];
  const headers = { 'User-Agent': 'dsh-windows-client/1.0', Accept: '*/*' };
  let lastErr = null;
  for (const useProxy of attempts) {
    try {
      const { res } = await requestFollowRedirects(url, { headers }, useProxy);
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let done = 0;
      const file = fs.createWriteStream(dest);
      await new Promise((resolve, reject) => {
        res.on('data', (chunk) => {
          done += chunk.length;
          if (total > 0 && done % (4 * 1024 * 1024) < chunk.length) {
            emit('progress', { pct: Math.min(99, Math.round((done / total) * 100)), message: `下载中 ${(done / 1048576).toFixed(1)}MB / ${(total / 1048576).toFixed(1)}MB` });
          }
        });
        res.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        res.on('error', reject);
      });
      return dest;
    } catch (e) {
      lastErr = e;
      try { fs.unlinkSync(dest); } catch (e2) { /* ignore */ }
      emit('log', { message: `下载尝试失败（${useProxy ? '代理' : '直连'}）: ${e.message}，切换重试…` });
    }
  }
  throw lastErr || new Error('下载失败: ' + url);
}

async function unzip(zipFile, destDir, onLine) {
  const stat = fs.statSync(zipFile);
  if (stat.size < 1000) throw new Error(`解压失败：压缩包疑似不完整（${stat.size} 字节）`);
  if (!IS_WIN) {
    // macOS / Linux：tar 自动识别 gz/xz
    try {
      await runCmdAsync(`tar -xf "${zipFile}" -C "${destDir}"`, { timeout: 300000, onLine });
      return;
    } catch (e) {
      throw new Error('解压失败: ' + e.message);
    }
  }
  // Windows 10+ 自带 bsdtar（--force-local 防止把 C:\ 等路径当远程主机）
  try {
    await runCmdAsync(`tar --force-local -xf "${zipFile}" -C "${destDir}"`, { timeout: 300000, onLine });
    return;
  } catch (e1) {
    // 回退：PowerShell Expand-Archive（绝对路径，PATH 残缺也能找到）
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    try {
      await runCmdAsync(`"${ps}" -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force"`, { timeout: 300000, onLine });
    } catch (e2) {
      throw new Error('解压失败: ' + (e2.message || e1.message || '未知错误'));
    }
  }
}

function rmrf(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    /* ignore */
  }
}

function flattenDir(src, dst) {
  // 把 zip 解出的单层目录（node-v22.x-win-x64）拍平到 dst
  const entries = fs.readdirSync(src);
  const only = entries.filter((n) => !n.startsWith('.'));
  if (only.length === 1 && fs.statSync(path.join(src, only[0])).isDirectory()) {
    const inner = path.join(src, only[0]);
    fs.mkdirSync(dst, { recursive: true });
    for (const item of fs.readdirSync(inner)) {
      fs.renameSync(path.join(inner, item), path.join(dst, item));
    }
    rmrf(src);
  } else {
    fs.mkdirSync(dst, { recursive: true });
    for (const item of entries) {
      fs.renameSync(path.join(src, item), path.join(dst, item));
    }
    rmrf(src);
  }
}

function parseNodeVersion(out) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(out || '');
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function nodeVersionOk(v) {
  if (!v) return false;
  if (v.major < NODE_LTS_MAJOR) return false;
  if (v.major === NODE_LTS_MAJOR && v.minor < 19) return false; // engines: ^22.19.0 || >=24
  return true;
}

async function httpGetJson(url, timeout = 20000) {
  const proxy = proxyAllowed() ? detectProxy() : null;
  const attempts = proxy ? [proxy, null] : [null];
  const headers = { 'User-Agent': 'dsh-windows-client/1.0', Accept: '*/*' };
  let lastErr = null;
  for (const useProxy of attempts) {
    try {
      const { res } = await requestFollowRedirects(url, { headers }, useProxy);
      if (res.statusCode !== 200) {
        res.resume();
        throw new Error(`HTTP ${res.statusCode}`);
      }
      let body = '';
      const data = await new Promise((resolve, reject) => {
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(body));
        res.on('error', reject);
      });
      return JSON.parse(data);
    } catch (e) {
      lastErr = e;
      // 静默切换（代理/直连）
    }
  }
  throw lastErr || new Error('请求失败: ' + url);
}

// ---------------- 检测 ----------------

/** 私有 runtime 下的 node 可执行文件（分平台）。 */
function privateNodeExe() {
  return IS_WIN
    ? path.join(runtimeDir(), 'node', 'node.exe')
    : path.join(runtimeDir(), 'node', 'bin', 'node');
}

/** 私有 runtime 下的 bin 脚本名（Windows 带 .cmd）。 */
function binName(name) {
  return IS_WIN ? name + '.cmd' : name;
}

function findOnPath(exe) {
  if (IS_WIN) {
    const res = runExe('where.exe', [exe], { timeout: 15000 });
    if (res.status !== 0) return null;
    const line = (res.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => {
        if (!s) return false;
        const lower = s.toLowerCase();
        return lower.endsWith('.exe') || lower.endsWith('.cmd');
      });
    return line || null;
  }
  // macOS / 其他：which
  const res = runExe('/usr/bin/which', [exe], { timeout: 15000, env: withRuntimePath(process.env) });
  if (res.status !== 0) return null;
  const line = (res.stdout || '').split(/\r?\n/).map((s) => s.trim()).find((s) => s !== '');
  return line || null;
}

function detectNode() {
  // 1) 私有运行时里的 node
  const privateNode = privateNodeExe();
  if (fs.existsSync(privateNode)) return privateNode;
  // 2) 系统 PATH 中的 node（校验版本）
  const sys = findOnPath(IS_WIN ? 'node.exe' : 'node');
  if (sys && fs.existsSync(sys)) {
    const ver = parseNodeVersion(runExe(sys, ['--version']).stdout);
    if (nodeVersionOk(ver)) return sys;
  }
  return null;
}

function detectPnpm() {
  const privatePnpm = path.join(runtimeDir(), 'node_modules', '.bin', binName('pnpm'));
  if (fs.existsSync(privatePnpm)) return privatePnpm;
  const sys = findOnPath(binName('pnpm')) || (IS_WIN ? findOnPath('pnpm.exe') : null);
  if (sys && fs.existsSync(sys)) return sys;
  return null;
}

function detectDshOnPath() {
  const p = findOnPath(binName('dsh')) || (IS_WIN ? findOnPath('dsh.exe') : null);
  if (p && fs.existsSync(p)) return p;
  return null;
}

function privateDshBin() {
  return path.join(runtimeDir(), 'node_modules', '.bin', binName('dsh'));
}

function compareDshVersions(left, right) {
  const parse = (value) => {
    if (typeof value !== 'string') return null;
    const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(value);
    if (!match) return null;
    const pre = match[4] ? match[4].split('.') : [];
    if (pre.some((part) => /^0\d+$/.test(part))) return null;
    return { core: match.slice(1, 4).map(BigInt), pre };
  };
  const a = parse(left);
  const b = parse(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (!a.pre.length || !b.pre.length) return a.pre.length === b.pre.length ? 0 : a.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    if (a.pre[i] === b.pre[i]) continue;
    const aNumeric = /^\d+$/.test(a.pre[i]);
    const bNumeric = /^\d+$/.test(b.pre[i]);
    if (aNumeric && bNumeric) return BigInt(a.pre[i]) < BigInt(b.pre[i]) ? -1 : 1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return a.pre[i] < b.pre[i] ? -1 : 1;
  }
  return 0;
}

function privateDshVersion() {
  try {
    const file = path.join(runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch (e) {
    return null;
  }
}

function privateDshNeedsUpgrade() {
  return compareDshVersions(privateDshVersion(), MIN_PRIVATE_DSH_VERSION) === -1;
}

/** 私有 runtime 优先，其次 PATH。客户端默认不写系统 PATH，所以必须查私有目录。 */
function detectDsh() {
  const privateBin = privateDshBin();
  if (fs.existsSync(privateBin)) return privateBin;
  return detectDshOnPath();
}

function detectCheckout() {
  for (const dir of CHECKOUT_CANDIDATES()) {
    if (!dir || !fs.existsSync(dir)) continue;
    const pkg = path.join(dir, 'package.json');
    const modules = path.join(dir, 'node_modules');
    const dist = path.join(dir, 'apps', 'web', 'dist', 'index.html');
    if (fs.existsSync(pkg) && fs.existsSync(modules)) {
      return { dir, built: fs.existsSync(dist) };
    }
  }
  return null;
}

function isServerUp(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

/** 探测端口上的 HTTP 状态码（dsh >= 0.2 起未认证访问根路径返回 401）。 */
function probeStatus(port = PORT) {
  return new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, { timeout: 2500 }, (res) => {
      res.resume();
      resolve(res.statusCode || 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}

/**
 * dsh >= 0.2 的浏览器认证：`dsh web` 把 `?token=<launchToken>` 打进启动 URL，
 * 带着它请求根路径会种下 HttpOnly cookie，之后才允许访问页面。
 * 客户端内嵌窗口必须用带 token 的 URL 首次加载，否则只会看到 401 文本。
 */
const TOKEN_RE = /https?:\/\/(?:127\.0\.0\.1|localhost):(\d+)\/\?token=([A-Za-z0-9_-]+)/;

/** 从 `dsh web` 的输出里解析带 token 的启动 URL。 */
function parseLaunchUrl(text) {
  const m = TOKEN_RE.exec(String(text || ''));
  if (!m) return null;
  return { port: Number(m[1]), token: m[2], url: `http://127.0.0.1:${m[1]}/?token=${m[2]}` };
}

function exchangeToken(launch, timeout = 8000) {
  return new Promise((resolve) => {
    if (!launch || !launch.url) {
      resolve(null);
      return;
    }
    const req = http.get(launch.url, { timeout }, (res) => {
      res.resume();
      const setCookie = res.headers['set-cookie'];
      resolve({
        ok: res.statusCode === 303 || res.statusCode === 302 || res.statusCode === 200,
        status: res.statusCode,
        cookies: Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [],
        url: `http://127.0.0.1:${launch.port}/`,
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function waitForServer(timeoutMs = MAX_POLL_MS, emit = () => {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerUp()) return true;
    emit('status', { message: '等待 dsh 服务就绪…' });
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return false;
}

// ---------------- 安装 ----------------

async function installNode(onEvent) {
  const emit = createEmitter(onEvent);
  const rt = runtimeDir();
  fs.mkdirSync(rt, { recursive: true });
  const dest = path.join(rt, 'node');
  const destExe = IS_WIN ? path.join(dest, 'node.exe') : path.join(dest, 'bin', 'node');
  if (fs.existsSync(destExe)) return destExe;

  emit('status', { message: '未检测到可用的 Node.js，正在从国内镜像下载安装…' });

  // 从 npmmirror 的 index.json 取最新的 v22.x LTS
  let version = `v${NODE_LTS_MAJOR}.19.0`;
  try {
    const idx = await httpGetJson(`${mirrors().node}/index.json`);
    const candidates = idx
      .filter((e) => e.version && e.version.startsWith(`v${NODE_LTS_MAJOR}.`))
      .sort((a, b) => {
        const va = parseNodeVersion(a.version);
        const vb = parseNodeVersion(b.version);
        if (!va || !vb) return 0;
        return va.major - vb.major || va.minor - vb.minor || va.patch - vb.patch;
      });
    const pick = candidates[candidates.length - 1];
    if (pick && pick.version) version = pick.version;
  } catch (e) {
    emit('log', { message: `获取 Node 版本列表失败，使用默认版本 ${version}: ${e.message}` });
  }

  // Windows: win-x64.zip；macOS: darwin-arm64/x64.tar.gz；Linux: linux-arm64/x64.tar.gz
  let zipName;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (IS_WIN) {
    zipName = `node-${version}-win-x64.zip`;
  } else if (IS_MAC) {
    zipName = `node-${version}-darwin-${arch}.tar.gz`;
  } else {
    zipName = `node-${version}-linux-${arch}.tar.gz`;
  }
  const url = `${mirrors().node}/${version}/${zipName}`;
  const zipFile = path.join(rt, zipName);
  emit('progress', { pct: 0, message: `下载 ${zipName}…` });
  await download(url, zipFile, emit);

  emit('status', { message: '解压 Node.js…' });
  const tmp = path.join(rt, `_node_tmp_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    await unzip(zipFile, tmp, line => {
      emit('progress', { message: `解压中：${line.slice(0, 80)}` });
    });
    flattenDir(tmp, dest);
  } finally {
    rmrf(tmp);
    try {
      fs.unlinkSync(zipFile);
    } catch (e) {
      /* ignore */
    }
  }
  if (!fs.existsSync(destExe)) throw new Error(`Node.js 安装失败：未找到 ${path.basename(destExe)}`);
  emit('status', { message: `Node.js 已就绪: ${version}` });
  return destExe;
}

async function installPnpm(nodeExe, onEvent) {
  const emit = createEmitter(onEvent);
  const rt = runtimeDir();
  const privatePnpm = path.join(rt, 'node_modules', '.bin', binName('pnpm'));
  if (fs.existsSync(privatePnpm)) return privatePnpm;

  emit('status', { message: `安装 pnpm@${PNPM_VERSION}（国内镜像，私有目录）…` });
  const npmCmd = path.join(path.dirname(nodeExe), binName('npm'));
  let lastErr = null;
  try {
    // 异步执行 + 实时进度（不阻塞主进程，避免新环境首启"无响应"）
    await runCmdAsync(`"${npmCmd}" install --prefix "${rt}" pnpm@${PNPM_VERSION} --registry=${mirrors().npm} --no-audit --no-fund${proxyArgs()}`, {
      timeout: 300000,
      env: withRuntimePath(process.env, nodeExe),
      onLine: progressRelay(line => {
        emit('progress', { message: line.slice(0, 160) });
      }),
    });
  } catch (e) {
    lastErr = e;
  }
  // 以 bin 是否生成判定（npm 可能因警告/重试返回非零但实际成功）
  if (!fs.existsSync(privatePnpm)) {
    throw new Error(`pnpm 安装失败: ${lastErr ? lastErr.message : '未生成 ' + binName('pnpm')}`);
  }
  emit('status', { message: `pnpm@${PNPM_VERSION} 已就绪` });
  return privatePnpm;
}

async function installDsh(nodeExe, onEvent) {
  const emit = createEmitter(onEvent);
  const rt = runtimeDir();
  const bin = path.join(rt, 'node_modules', '.bin', binName('dsh'));
  const upgrading = fs.existsSync(bin) && privateDshNeedsUpgrade();
  if (fs.existsSync(bin) && !upgrading) return bin;

  emit('status', { message: upgrading
    ? `正在升级客户端私有 DeepSeek Harness：${privateDshVersion()} → ${MIN_PRIVATE_DSH_VERSION}…`
    : `安装 ${DSH_PACKAGE}（私有目录）…` });
  const npmCmd = path.join(path.dirname(nodeExe), binName('npm'));
  let lastErr = null;
  try {
    // 异步执行 + 实时进度（不阻塞主进程，避免新环境首启"无响应"）
    await runCmdAsync(`"${npmCmd}" install --prefix "${rt}" ${DSH_PACKAGE} --registry=${mirrors().npm} --no-audit --no-fund${proxyArgs()}`, {
      timeout: 1200000,
      env: withRuntimePath(process.env, nodeExe),
      onLine: progressRelay(line => {
        emit('progress', { message: line.slice(0, 160) });
      }),
    });
  } catch (e) {
    lastErr = e;
  }
  // npm 可能因网络重试/警告返回非零但实际已装好：以 bin 是否生成判定
  if (!fs.existsSync(bin)) {
    throw new Error(`dsh 安装失败: ${lastErr ? lastErr.message : '未生成 ' + binName('dsh')}`);
  }
  if (upgrading) {
    const installed = privateDshVersion();
    const comparison = compareDshVersions(installed, MIN_PRIVATE_DSH_VERSION);
    if (comparison === null || comparison < 0) {
      throw new Error(`dsh 私有运行时升级失败：${lastErr ? lastErr.message : `安装后版本仍为 ${installed || '未知'}，需要 ${MIN_PRIVATE_DSH_VERSION} 或更新版本`}`);
    }
  }
  emit('status', { message: upgrading ? '客户端私有 DeepSeek Harness 已升级' : 'DeepSeek Harness 已安装到私有目录' });
  return bin;
}

// ---------------- 启动 ----------------

async function prepareToStart(onEvent) {
  const emit = createEmitter(onEvent);
  const nodeExe = detectNode();

  // 1) 本地源码仓库（已构建）优先 —— 不重复下载
  const checkout = detectCheckout();
  if (checkout) {
    if (!checkout.built) {
      emit('log', { message: '检测到源码仓库但 Web 前端未构建，回退到 npm 安装方式。' });
    } else {
      let node = nodeExe;
      if (!node) node = await installNode(onEvent);
      emit('status', { message: `使用本地源码仓库启动: ${checkout.dir}` });
      return {
        command: `"${node}" --import tsx/esm apps/cli/src/bin.ts web --no-open --port ${PORT}`,
        file: node,
        args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web', '--no-open', '--port', String(PORT)],
        cwd: checkout.dir,
        env: withRuntimePath(process.env, node),
      };
    }
  }

  // 2/3) 已有 dsh（私有 runtime 优先，其次 PATH）或全新安装
  let node = nodeExe;
  if (!node) node = await installNode(onEvent);
  let dshBin = detectDsh();
  if (!dshBin || (dshBin === privateDshBin() && privateDshNeedsUpgrade())) dshBin = await installDsh(node, onEvent);
  emit('status', { message: '启动 DeepSeek Harness Web…' });
  return {
    command: `"${dshBin}" web --no-open --port ${PORT}`,
    file: dshBin,
    args: ['web', '--no-open', '--port', String(PORT)],
    cwd: os.homedir(),
    env: withRuntimePath({ ...process.env }, node),
  };
}

function spawnServer(plan, emit) {
  if (IS_WIN) {
    // 通过临时 .cmd 文件执行：spawn(cmd,['/s','/c',command]) 会被 cmd 的引号剥离破坏
    // （含引号的路径变成 \"...\" 字面量 → "不是内部或外部命令"）。写成批处理文件后由
    // cmd 按标准规则解析，引号/路径/命令都可靠（与 runCmd 同一方案）。
    const bat = path.join(os.tmpdir(), `dsh-srv-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.cmd`);
    fs.writeFileSync(bat, '@echo off\r\n' + plan.command + '\r\n', 'utf8');
    const child = spawn(resolveCmd(), ['/d', '/c', `"${bat}"`], {
      cwd: plan.cwd,
      env: withSanePath(plan.env || process.env),
      windowsHide: false,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // 服务退出后清理批处理文件
    child.on('close', () => {
      try { fs.unlinkSync(bat); } catch (e) { /* ignore */ }
    });
    attachServerLogs(child, emit, plan.onLaunchUrl);
    return child;
  }
  const child = spawn(plan.file, plan.args, {
    cwd: plan.cwd,
    env: plan.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });
  attachServerLogs(child, emit, plan.onLaunchUrl);
  return child;
}

function attachServerLogs(child, emit, onLaunchUrl) {
  const push = (line) => {
    const text = line.trim();
    if (!text) return;
    if (onLaunchUrl) {
      const parsed = parseLaunchUrl(text);
      if (parsed && parsed.port === PORT) onLaunchUrl(parsed);
    }
    emit('server', { message: text.replace(/([?&]token=)[^\s\x1b]+/g, '$1[已隐藏]') });
  };
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue;
    let pending = '';
    let truncated = false;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      pending += chunk;
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        if (!truncated) push(pending.slice(0, end));
        truncated = false;
        pending = pending.slice(end + 1);
      }
      if (pending.length > 65536) {
        pending = '';
        truncated = true;
      }
    });
    stream.on('end', () => { if (!truncated) push(pending); });
  }
  child.on('error', (e) => emit('error', { message: '启动进程失败: ' + e.message }));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function trackServer(child) {
  let stopped = false;
  let closed = false;
  let cleanupComplete = false;
  let stopPromise = null;
  let failure = null;
  let resolveExit;
  const exited = new Promise((resolve) => { resolveExit = resolve; });
  const signal = (name) => {
    if (!child.pid || cleanupComplete || (IS_WIN && closed)) return;
    try {
      if (IS_WIN) {
        const killer = spawn(resolveCmd(), ['/d', '/c', `taskkill /PID ${child.pid} /T /F`], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => {});
      } else {
        process.kill(-child.pid, name);
      }
    } catch (e) {}
  };
  const active = () => {
    if (!child.pid || cleanupComplete) return false;
    if (IS_WIN) return !closed;
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (e) {
      return e.code !== 'ESRCH';
    }
  };
  child.once('error', (error) => {
    failure = error;
    resolveExit();
  });
  child.once('exit', (code, sig) => {
    failure = new Error(`dsh 进程已退出（${sig || code}）`);
    resolveExit();
    if (!stopped) void stop();
  });
  child.once('close', () => {
    closed = true;
  });
  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    signal('SIGTERM');
    stopPromise = (async () => {
      const deadline = Date.now() + 1500;
      while (active() && Date.now() < deadline) await delay(50);
      if (active()) {
        signal('SIGKILL');
        const killDeadline = Date.now() + 1500;
        while (active() && Date.now() < killDeadline) await delay(50);
      }
      cleanupComplete = true;
    })();
    return stopPromise;
  };
  return { child, exited, stop, get failure() { return failure; } };
}

// ---------------- 主流程 ----------------

/**
 * 执行完整引导流程。
 * @param {object} opts
 * @param {(event:object)=>void} [opts.onEvent]
 * @returns {Promise<{url:string, alreadyRunning:boolean, process:ChildProcess|null, stop:Function}>}
 */

// ---------------- dshup 客户端插件（注入官方 Web 左下角「设置」与输入栏） ----------------

const DSHUP_PLUGIN_ID = 'dshup-client-settings';

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function dshupPluginSourceDir() {
  return path.join(__dirname, 'plugin', DSHUP_PLUGIN_ID);
}

function copyDirOverwrite(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  let entries;
  try {
    entries = fs.readdirSync(src, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) {
      copyDirOverwrite(from, to);
    } else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

function ensureCordisPatch(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { text = ''; }
  if (text.includes(DSHUP_PLUGIN_ID)) return false;
  const block = `- insert:\n    - id: ${DSHUP_PLUGIN_ID}\n      name: ${DSHUP_PLUGIN_ID}\n`;
  const trimmedLines = text.split(/\r?\n/);
  const hasYamlItem = trimmedLines.some((line) => /^\s*-\s/.test(line));
  if (!text.trim()) {
    fs.writeFileSync(file, block, 'utf8');
    return true;
  }
  if (!hasYamlItem && /\[\s*\]/.test(text)) {
    text = text.replace(/\[\s*\]/, block.trimEnd());
    if (!text.endsWith('\n')) text += '\n';
    fs.writeFileSync(file, text, 'utf8');
    return true;
  }
  if (!text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text + block, 'utf8');
  return true;
}

function ensureDshupClientPlugin(emit) {
  const log = (message) => { if (emit) emit('log', { message }); };
  const src = dshupPluginSourceDir();
  if (!fs.existsSync(src)) {
    log('未找到内置 dshup-client-settings 插件目录，跳过注入');
    return { copied: false, patched: false };
  }
  const dest = path.join(dshHomeDir(), 'profiles', 'node_modules', DSHUP_PLUGIN_ID);
  try {
    copyDirOverwrite(src, dest);
    log(`已安装客户端插件: ${dest}`);
  } catch (e) {
    log('复制客户端插件失败: ' + (e && e.message ? e.message : e));
  }
  const patchFile = path.join(dshHomeDir(), 'profiles', 'web', 'cordis.patch.yml');
  try {
    if (ensureCordisPatch(patchFile)) log('已写入 web 配置补丁: ' + patchFile);
  } catch (e) {
    log('写入 cordis.patch.yml 失败: ' + (e && e.message ? e.message : e));
  }
  // dsh >= 0.2 的输入栏把 conversation.input.right 排在 model 槽位之前，
  // 旧版靠改 npm 包源码调整顺序的补丁已无必要（且会破坏包完整性校验），这里不再做。
  return { copied: true };
}

function cookieHeader(cookies = []) {
  return cookies.map((cookie) => String(cookie).split(';')[0].trim()).filter(Boolean).join('; ');
}

function fetchPage(url, timeout = 4000, headers = null) {
  return new Promise((resolve) => {
    let settled = false;
    let timer;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const req = http.get(url, { headers: headers || {} }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) {
          req.destroy();
          finish({ status: 0, html: '' });
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => finish({ status: res.statusCode || 0, html: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', () => finish({ status: 0, html: '' }));
      res.on('aborted', () => finish({ status: 0, html: '' }));
    });
    req.on('error', () => finish({ status: 0, html: '' }));
    timer = setTimeout(() => {
      req.destroy();
      finish({ status: 0, html: '' });
    }, timeout);
  });
}

async function fetchHtml(url, timeout = 4000, headers = null) {
  return (await fetchPage(url, timeout, headers)).html;
}

async function htmlHasDshupPlugin(auth = null) {
  const url = typeof auth === 'string' ? auth : APP_URL;
  const headers = auth && auth.cookies ? { Cookie: cookieHeader(auth.cookies) } : null;
  const page = await fetchPage(url, 4000, headers);
  return page.status === 200 && page.html.includes(DSHUP_PLUGIN_ID);
}

async function authenticate(launch, timeout = 8000) {
  if (!launch) return null;
  const result = await exchangeToken(launch, timeout);
  if (!result || !result.ok || result.cookies.length === 0) return null;
  return result;
}

function isPortListening(port = PORT) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const finish = (listening) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(1000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(true));
  });
}

function isDshPage(page) {
  return page.status === 200 && /__DSH_BOOT__|dshup-client-settings|<title>\s*DeepSeek Harness\s*<\/title>/i.test(page.html);
}

async function waitForLaunch(ready, record, timeout) {
  let timer;
  try {
    return await Promise.race([
      ready,
      record.exited.then(() => { throw record.failure; }),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeout); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap(opts = {}) {
  const emit = createEmitter(opts.onEvent);
  const startedAt = Date.now();
  const authCookies = opts.authCookies || [];
  if (!Array.isArray(authCookies) || authCookies.some((cookie) => typeof cookie !== 'string' || /[\r\n]/.test(cookie))) {
    throw new Error('authCookies 必须是有效的 Cookie 字符串数组');
  }
  const existing = await fetchPage(APP_URL, 1500, { Cookie: cookieHeader(authCookies) });
  if (existing.status || await isPortListening()) {
    if (existing.status === 401 || existing.status === 403) {
      throw new Error(`端口 ${PORT} 已有需要授权的 dsh 服务，当前客户端没有有效登录状态。请先关闭该服务，再重试；已有进程未被结束。`);
    }
    if (!isDshPage(existing)) {
      throw new Error(`端口 ${PORT} 已被其他服务占用。请关闭该服务，或通过 DSH_PORT 选择其他端口；已有进程未被结束。`);
    }
    if (!existing.html.includes(DSHUP_PLUGIN_ID)) {
      emit('log', { message: '复用已有 dsh 服务；该实例未加载客户端插件，部分桌面设置入口可能不可用。' });
    }
    emit('status', { message: `检测到 dsh 已在运行（${APP_URL}）` });
    return { url: APP_URL, launchUrl: null, browserUrl: authCookies.length ? null : APP_URL, token: null, cookies: authCookies, alreadyRunning: true, process: null, stop: async () => {} };
  }

  ensureDshupClientPlugin(emit);
  const plan = await prepareToStart(opts.onEvent);
  emit('log', { message: `启动命令: ${plan.command} (cwd=${plan.cwd})` });
  const startupTimeout = Number.isFinite(opts.startupTimeoutMs) && opts.startupTimeoutMs > 0 ? opts.startupTimeoutMs : MAX_POLL_MS;
  const authTimeout = Number.isFinite(opts.authTimeoutMs) && opts.authTimeoutMs > 0 ? opts.authTimeoutMs : 8000;
  let current = null;

  const startChild = async () => {
    let launch = null;
    let resolveLaunch;
    const launchReady = new Promise((resolve) => { resolveLaunch = resolve; });
    const child = spawnServer({ ...plan, onLaunchUrl: (parsed) => {
      if (launch) return;
      launch = parsed;
      resolveLaunch(parsed);
      emit('log', { message: '已获取 dsh 访问令牌' });
    } }, emit);
    const record = trackServer(child);
    current = record;
    const deadline = Date.now() + startupTimeout;
    let page = { status: 0, html: '' };
    let lastStatus = 0;
    let auth = null;
    while (Date.now() < deadline) {
      if (record.failure) throw record.failure;
      page = await fetchPage(
        APP_URL,
        Math.min(1000, Math.max(1, deadline - Date.now())),
        auth ? { Cookie: cookieHeader(auth.cookies) } : null,
      );
      if (record.failure) throw record.failure;
      if (page.status) lastStatus = page.status;
      if ((page.status === 401 || page.status === 403) && !auth) {
        if (!launch) {
          launch = await waitForLaunch(launchReady, record, Math.min(authTimeout, Math.max(1, deadline - Date.now())));
        }
        if (!launch) throw new Error('dsh 需要浏览器授权，但未获取到启动令牌。请查看日志后重试。');
        auth = await authenticate(launch, Math.min(8000, Math.max(1, deadline - Date.now())));
        if (record.failure) throw record.failure;
        if (!auth) throw new Error('dsh 浏览器授权失败，启动令牌未能换取有效登录状态。请重试。');
        emit('log', { message: '已完成 dsh 浏览器授权' });
        continue;
      }
      if (isDshPage(page)) {
        return { record, auth, browserUrl: launch ? launch.url : APP_URL, hasPlugin: page.html.includes(DSHUP_PLUGIN_ID) };
      }
      emit('status', { message: '等待 dsh 服务就绪…' });
      await Promise.race([delay(Math.min(200, Math.max(1, deadline - Date.now()))), record.exited]);
    }
    if (record.failure) throw record.failure;
    const seconds = Math.ceil(startupTimeout / 1000);
    if (!lastStatus) throw new Error(`等待 dsh 服务启动超时（${seconds} 秒），未收到 HTTP 响应。请查看日志窗口了解详情。`);
    if (auth && (lastStatus === 401 || lastStatus === 403)) {
      throw new Error(`dsh 浏览器授权未生效（HTTP ${lastStatus}），等待 ${seconds} 秒后仍无法访问页面。请重试。`);
    }
    throw new Error(`等待 dsh 页面就绪超时（${seconds} 秒，最后 HTTP ${lastStatus}）。服务仍未返回可用页面，请查看日志后重试。`);
  };

  try {
    let started = await startChild();
    if (!started.hasPlugin) {
      ensureDshupClientPlugin(emit);
      emit('status', { message: '客户端插件尚未进入页面，正在重启本客户端启动的 dsh…' });
      await started.record.stop();
      started = await startChild();
      if (!started.hasPlugin) emit('log', { message: 'dsh 已就绪，但客户端插件未能加载；请检查插件配置。' });
    }
    emit('status', { message: `dsh 已就绪，共耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒` });
    return {
      url: APP_URL,
      launchUrl: null,
      browserUrl: started.browserUrl,
      cookies: started.auth ? started.auth.cookies : [],
      token: null,
      alreadyRunning: false,
      process: started.record.child,
      stop: started.record.stop,
    };
  } catch (error) {
    if (current) await current.stop();
    throw error;
  }
}


module.exports = {
  PORT,
  APP_URL,
  MIN_PRIVATE_DSH_VERSION,
  bootstrap,
  isServerUp,
  ensureDshupClientPlugin,
  htmlHasDshupPlugin,
  runtimeDir,
  clientBaseDir,
  detectNode,
  detectPnpm,
  detectCheckout,
  detectDshOnPath,
  detectDsh,
  privateDshBin,
  privateDshVersion,
  privateDshNeedsUpgrade,
  prepareToStart,
  withRuntimePath,
  waitForServer,
  parseLaunchUrl,
  fetchHtml,
  probeStatus,
  exchangeToken,
  authenticate,
  installNode,
  installPnpm,
  installDsh,
  detectProxy,
  httpGetJson,
  unzip,
  flattenDir,
  download,
  resolveCmd,
  withSanePath,
};
