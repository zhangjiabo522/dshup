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

const PORT = 3080;
const APP_URL = `http://127.0.0.1:${PORT}/`;
const NPM_MIRROR = 'https://registry.npmmirror.com';
const NODE_MIRROR = 'https://npmmirror.com/mirrors/node';
const NODE_LTS_MAJOR = 22; // 需要私有安装时使用的 LTS 大版本（npmmirror 镜像）
const PNPM_VERSION = '11.7.0'; // 与 deepseek-harness 仓库 packageManager 一致
const DSH_PACKAGE = '@deepseek-ai/dsh';
const MAX_POLL_MS = 180000; // 等待 dsh 启动的最长时间
const POLL_INTERVAL_MS = 1200;

// 平台分支：Windows（cmd/where/注册表）与 macOS（sh/which/launchd 由 Electron API 处理）
const IS_WIN = process.platform === 'win32';
const IS_MAC = process.platform === 'darwin';

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
  const base = IS_WIN
    ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    : path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(base, 'DeepSeekHarnessClient', 'runtime');
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
  const proxy = detectProxy();
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

function unzip(zipFile, destDir) {
  const stat = fs.statSync(zipFile);
  if (stat.size < 1000) throw new Error(`解压失败：压缩包疑似不完整（${stat.size} 字节）`);
  if (IS_MAC || !IS_WIN) {
    // macOS：tar（支持 gz/zip）
    const r = runCmd(`tar -xzf "${zipFile}" -C "${destDir}"`);
    if (r.status !== 0) throw new Error('解压失败: ' + (r.stderr || r.stdout || '未知错误'));
    return;
  }
  // Windows 10+ 自带 bsdtar（--force-local 防止把 C:\ 等路径当远程主机）
  const r1 = runCmd(`tar --force-local -xf "${zipFile}" -C "${destDir}"`);
  if (r1.status === 0) return;
  // 回退：PowerShell Expand-Archive
  const r2 = runCmd(`powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force"`);
  if (r2.status !== 0) {
    throw new Error('解压失败: ' + (r2.stderr || r2.stdout || r1.stderr || '未知错误'));
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
  const proxy = detectProxy();
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
  const res = runExe('/usr/bin/which', [exe], { timeout: 15000 });
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

async function waitForServer(timeoutMs = MAX_POLL_MS, emit) {
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
    const idx = await httpGetJson(`${NODE_MIRROR}/index.json`);
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

  // Windows: win-x64.zip；macOS: darwin-arm64.tar.gz（Apple Silicon）/ darwin-x64.tar.gz
  let zipName;
  if (IS_WIN) {
    zipName = `node-${version}-win-x64.zip`;
  } else {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
    zipName = `node-${version}-darwin-${arch}.tar.gz`;
  }
  const url = `${NODE_MIRROR}/${version}/${zipName}`;
  const zipFile = path.join(rt, zipName);
  emit('progress', { pct: 0, message: `下载 ${zipName}…` });
  await download(url, zipFile, emit);

  emit('status', { message: '解压 Node.js…' });
  const tmp = path.join(rt, `_node_tmp_${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  try {
    unzip(zipFile, tmp);
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
  const r = runCmd(`"${npmCmd}" install --prefix "${rt}" pnpm@${PNPM_VERSION} --registry=${NPM_MIRROR} --no-audit --no-fund${proxyArgs()}`, {
    timeout: 300000,
  });
  // 以 bin 是否生成判定（npm 可能因警告/重试返回非零但实际成功）
  if (!fs.existsSync(privatePnpm)) {
    const detail = (r.stderr || r.stdout || '未知错误')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^npm warn/i.test(l.trim()))
      .join('\n');
    throw new Error(`pnpm 安装失败: ${detail || '未生成 ' + binName('pnpm')}`);
  }
  emit('status', { message: `pnpm@${PNPM_VERSION} 已就绪` });
  return privatePnpm;
}

async function installDsh(nodeExe, onEvent) {
  const emit = createEmitter(onEvent);
  const rt = runtimeDir();
  const bin = path.join(rt, 'node_modules', '.bin', binName('dsh'));
  if (fs.existsSync(bin)) return bin;

  emit('status', { message: `安装 ${DSH_PACKAGE}（国内镜像，私有目录）…` });
  const npmCmd = path.join(path.dirname(nodeExe), binName('npm'));
  const r = runCmd(`"${npmCmd}" install --prefix "${rt}" ${DSH_PACKAGE} --registry=${NPM_MIRROR} --no-audit --no-fund${proxyArgs()}`, {
    timeout: 600000,
  });
  // npm 可能因网络重试/警告返回非零但实际已装好：以 bin 是否生成判定
  if (!fs.existsSync(bin)) {
    const detail = (r.stderr || r.stdout || '未知错误')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !/^npm warn/i.test(l.trim()))
      .join('\n');
    throw new Error(`dsh 安装失败: ${detail || '未生成 ' + binName('dsh')}`);
  }
  emit('status', { message: 'DeepSeek Harness 已安装到私有目录' });
  return bin;
}

// ---------------- 启动 ----------------

async function prepareToStart(onEvent) {
  const emit = createEmitter(onEvent);
  // 返回 { command, cwd, env }
  const nodeExe = detectNode();
  let pnpm = detectPnpm();

  // 1) 本地源码仓库（已构建）优先 —— 不重复下载
  const checkout = detectCheckout();
  if (checkout) {
    if (!checkout.built) {
      emit('log', { message: '检测到源码仓库但 Web 前端未构建，回退到 npm 安装方式。' });
    } else {
      if (!pnpm) {
        if (!nodeExe) {
          const n = await installNode(onEvent);
          pnpm = await installPnpm(n, onEvent);
        } else {
          pnpm = await installPnpm(nodeExe, onEvent);
        }
      }
      emit('status', { message: `使用本地源码仓库启动: ${checkout.dir}` });
      // 用 pnpm 绝对路径调用，绝不修改 PATH：否则 dsh 进程环境会被私有 runtime
      // 目录污染，dsh 派生的所有工具（含打包脚本）都会错误解析 node/npm
      return { command: `"${pnpm}" dsh web`, cwd: checkout.dir, env: { ...process.env } };
    }
  }

  // 2) PATH 上已有 dsh
  const dshOnPath = detectDshOnPath();
  if (dshOnPath) {
    emit('status', { message: '检测到已安装的 dsh，直接启动' });
    return { command: 'dsh web', cwd: os.homedir(), env: { ...process.env } };
  }

  // 3) 私有安装 / 全新安装
  let node = nodeExe;
  if (!node) node = await installNode(onEvent);
  pnpm = pnpm || detectPnpm(); // 不需要 pnpm 时跳过
  const dshBin = await installDsh(node, onEvent);
  emit('status', { message: '启动 DeepSeek Harness Web…' });
  return { command: `"${dshBin}" web`, cwd: os.homedir(), env: { ...process.env } };
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
    attachServerLogs(child, emit);
    return child;
  }
  // macOS / 其他：/bin/bash -c
  const child = spawn('/bin/bash', ['-c', plan.command], {
    cwd: plan.cwd,
    env: plan.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  attachServerLogs(child, emit);
  return child;
}

function attachServerLogs(child, emit) {
  const push = (buf) => {
    const text = (buf || '').toString().trim();
    if (text) emit('server', { message: text });
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('error', (e) => emit('error', { message: '启动进程失败: ' + e.message }));
}

function killProcessTree(pid) {
  try {
    if (IS_WIN) {
      runCmd(`taskkill /PID ${pid} /T /F`, { timeout: 15000 });
    } else {
      // macOS：先杀子进程再杀本进程
      runCmd(`pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; sleep 1; kill -KILL ${pid} 2>/dev/null`, { timeout: 15000 });
    }
  } catch (e) {
    /* ignore */
  }
}

// ---------------- 主流程 ----------------

/**
 * 执行完整引导流程。
 * @param {object} opts
 * @param {(event:object)=>void} [opts.onEvent]
 * @param {boolean} [opts.killOnExit] 退出时是否结束由本客户端启动的服务进程（默认 true）
 * @returns {Promise<{url:string, alreadyRunning:boolean, process:ChildProcess|null, stop:Function}>}
 */
async function bootstrap(opts = {}) {
  const emit = createEmitter(opts.onEvent);
  const startedAt = Date.now();

  // 0) 已在运行？
  if (await isServerUp()) {
    emit('status', { message: `检测到 dsh 已在运行（${APP_URL}）` });
    return { url: APP_URL, alreadyRunning: true, process: null, stop: () => {} };
  }

  // 1) 准备启动命令
  const plan = await prepareToStart(opts.onEvent);
  emit('log', { message: `启动命令: ${plan.command} (cwd=${plan.cwd})` });

  // 2) 启动服务
  const child = spawnServer(plan, emit);

  // 3) 等待就绪
  const up = await waitForServer(MAX_POLL_MS, emit);
  if (!up) {
    killProcessTree(child.pid);
    throw new Error('等待 dsh 服务启动超时（180 秒）。请查看日志窗口了解详情。');
  }

  const stop = () => {
    try {
      if (child && child.pid) killProcessTree(child.pid);
    } catch (e) {
      /* ignore */
    }
  };
  emit('status', { message: `dsh 已就绪，共耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒` });
  return { url: APP_URL, alreadyRunning: false, process: child, stop };
}

module.exports = {
  PORT,
  APP_URL,
  bootstrap,
  isServerUp,
  runtimeDir,
  detectNode,
  detectPnpm,
  detectCheckout,
  detectDshOnPath,
  waitForServer,
  installNode,
  installPnpm,
  installDsh,
  detectProxy,
  httpGetJson,
  unzip,
  flattenDir,
  download,
};
