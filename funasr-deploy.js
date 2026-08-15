// funasr-deploy.js
// FunASR（Paraformer-large）一键部署与生命周期管理（客户端主进程调用）。
// 部署目录：%LOCALAPPDATA%\DeepSeekHarnessClient\funasr\
//   ├── venv\                独立 Python 虚拟环境（不污染用户 Python）
//   ├── server.py            内置 ASR HTTP 服务（POST /asr 收 raw WAV → 文本）
//   └── server.log           服务运行日志
// 全部走国内镜像/可达源：pip 用清华源、CPU torch 用官方 CPU 源（阿里云 pytorch
// 镜像已失效时自动回退清华源）、模型由 modelscope 自动下载。
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');

const BASE = () => {
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
      : path.join(os.homedir(), 'Library', 'Application Support');
  return path.join(base, 'DeepSeekHarnessClient', 'funasr');
};
const VENV_PY = () =>
  process.platform === 'win32'
    ? path.join(BASE(), 'venv', 'Scripts', 'python.exe')
    : path.join(BASE(), 'venv', 'bin', 'python');
const SERVER_PY = () => path.join(BASE(), 'server.py');
const SERVER_LOG = () => path.join(BASE(), 'server.log');
const DEFAULT_PORT = 10095;

const SERVER_PY_SOURCE = `# -*- coding: utf-8 -*-
# DeepSeek Harness 内置 FunASR 语音识别服务（Paraformer-large）
# 接口：POST /asr（body 为 WAV 原始字节，Content-Type: audio/wav）→ {"text": "..."}
#       GET /health → {"ok": true}
import json
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(os.environ.get('DSH_FUNASR_PORT', '10095'))

model = None

def load_model():
    global model
    from funasr import AutoModel
    # paraformer-zh = Paraformer-large 中文通用模型（modelscope 自动下载）
    model = AutoModel(model='paraformer-zh', disable_update=True)
    print('[funasr] model loaded', flush=True)

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        sys.stderr.write('[http] %s\\n' % (fmt % args))

    def do_GET(self):
        if self.path == '/health':
            body = json.dumps({'ok': model is not None}).encode('utf-8')
            self.send_response(200 if model is not None else 503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path != '/asr':
            self.send_response(404)
            self.end_headers()
            return
        if model is None:
            body = json.dumps({'error': 'model not loaded'}).encode('utf-8')
            self.send_response(503)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        length = int(self.headers.get('Content-Length', '0'))
        data = self.rfile.read(length)
        if not data:
            self.send_response(400)
            self.end_headers()
            return
        text = ''
        try:
            with tempfile.NamedTemporaryFile(suffix='.wav', delete=False) as f:
                f.write(data)
                tmp_path = f.name
            result = model.generate(input=tmp_path)
            if result and len(result) > 0 and result[0].get('text'):
                text = result[0]['text']
        except Exception as e:  # noqa: BLE001
            sys.stderr.write('[funasr] error: %s\\n' % e)
            text = ''
        finally:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
        body = json.dumps({'text': text}, ensure_ascii=False).encode('utf-8')
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

if __name__ == '__main__':
    print('[funasr] loading model (first run downloads Paraformer-large)...', flush=True)
    load_model()
    server = ThreadingHTTPServer(('127.0.0.1', PORT), Handler)
    print('[funasr] listening on 127.0.0.1:%d' % PORT, flush=True)
    server.serve_forever()
`;

// ---------------- 基础检测 ----------------

/** 异步执行命令（promisified execFile）—— 主进程绝不因探测/安装命令阻塞（UI 无响应的主要来源）。 */
function runAsync(exe, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const { execFile } = require('child_process');
    execFile(exe, args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: opts.timeout || 120000,
      maxBuffer: 16 * 1024 * 1024,
    }, (err, stdout) => {
      if (err) {
        const e = new Error(String((err && err.message) || err));
        e.stdout = stdout;
        reject(e);
      } else {
        resolve(stdout || '');
      }
    });
  });
}

async function tryRunAsync(exe, args, opts = {}) {
  try {
    return { ok: true, out: await runAsync(exe, args, opts) };
  } catch (e) {
    return { ok: false, out: String((e && e.stdout) || (e && e.message) || e) };
  }
}

/** 输出尾部关键行，用于错误信息（截断过长的 pip 输出）。 */
function tailLines(text, n) {
  const lines = String(text || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.slice(-n).join(' | ');
}

/**
 * 流式执行命令：stdout/stderr 逐行回调（pip 实时进度），超时强杀。
 * @returns 完整输出文本
 */
function runStreaming(exe, args, onLine, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: { ...process.env },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (e) { /* ignore */ }
    }, timeoutMs);
    const onData = buf => {
      const text = buf.toString('utf8');
      out += text;
      if (onLine) {
        for (const line of text.split(/\r?\n/)) {
          const clean = line.trim();
          if (clean !== '') onLine(clean);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) reject(new Error('安装超时（' + Math.round(timeoutMs / 60000) + ' 分钟）：' + tailLines(out, 6)));
      else if (code === 0) resolve(out);
      else reject(new Error('安装失败：' + tailLines(out, 8)));
    });
    child.on('error', e => {
      clearTimeout(timer);
      reject(new Error('无法启动进程: ' + e.message));
    });
  });
}

/** pip 输出行 → 进度事件（节流：每秒最多一条，只转发关键行）。 */
function pipProgressRelay(onProgress) {
  let lastForward = 0;
  return line => {
    const now = Date.now();
    if (now - lastForward < 1000) return;
    lastForward = now;
    if (/Downloading|Collecting|Installing|Building|Successfully|ERROR|error/i.test(line)) {
      onProgress({ type: 'progress', message: line.slice(0, 160) });
    }
  };
}

/**
 * pip 安装（多源自动回退）：依次尝试给定的源参数，最后用官方默认源兜底。
 * @param fallbackArgsList - 依次尝试的额外参数组（如 [['-i', 清华]]）
 */
async function pipInstallWithFallback(venvPy, packages, fallbackArgsList, relay, timeoutMs) {
  const attempts = [...fallbackArgsList, []];
  const errors = [];
  for (const extra of attempts) {
    try {
      return await runStreaming(venvPy, ['-m', 'pip', 'install', ...packages, ...extra], relay, timeoutMs);
    } catch (e) {
      errors.push(e.message);
    }
  }
  throw new Error(errors.join(' || '));
}

/** 解析 `python --version` 输出。 */
function parsePythonVersion(out) {
  const m = /Python (\d+)\.(\d+)(\.\d+)?/.exec(String(out || ''));
  if (!m) return null;
  return { major: +m[1], minor: +m[2] };
}

/** funasr + torch 生态稳定支持区间：3.8 - 3.11（3.12+ 缺 wheel）。 */
function pythonOk(v) {
  if (!v) return false;
  return v.major === 3 && v.minor >= 8 && v.minor <= 11;
}

async function versionOfAsync(exe) {
  try {
    const out = await runAsync(exe, ['--version'], { timeout: 20000 });
    return parsePythonVersion(out);
  } catch (e) {
    return null;
  }
}

async function findPython() {
  // 1) 部署目录 venv 自带且版本兼容
  if (fs.existsSync(VENV_PY()) && pythonOk(await versionOfAsync(VENV_PY()))) return VENV_PY();
  // 2) 常见安装路径直接探测（不依赖 PATH / py launcher / winget）
  const candidates = [];
  if (process.platform === 'win32') {
    const localApps = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    for (const v of ['311', '310', '39', '38']) {
      candidates.push(
        path.join(localApps, 'Programs', 'Python', 'Python' + v, 'python.exe'),
        'C:\\Python' + v + '\\python.exe',
        'C:\\Program Files\\Python' + v + '\\python.exe',
      );
    }
  } else {
    // macOS：常见 python3 位置
    candidates.push('/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3');
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && pythonOk(await versionOfAsync(c))) return c;
  }
  // 3) 系统 PATH 上的 python（3.8-3.11 才接受）
  const sysPy = await tryRunAsync(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', [process.platform === 'win32' ? 'python.exe' : 'python3'], { timeout: 15000 });
  if (sysPy.ok) {
    const line = (sysPy.out || '').split(/\r?\n/).map(s => s.trim()).find(s => s && (s.toLowerCase().endsWith('.exe') || s.includes('/')));
    if (line && pythonOk(await versionOfAsync(line))) return line;
  }
  // 4) py launcher（仅 Windows）指定版本
  if (process.platform === 'win32') {
    for (const v of ['3.11', '3.10', '3.9', '3.8']) {
      const r = await tryRunAsync('py.exe', ['-' + v, '-c', 'import sys; print(sys.executable)'], { timeout: 20000 });
      if (r.ok && r.out.trim()) {
        const exe = r.out.trim();
        if (pythonOk(await versionOfAsync(exe))) return exe;
      }
    }
  }
  return null;
}

/** winget 绝对路径（自启/PATH 残缺场景下也找得到）。 */
function wingetExe() {
  const localApps = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const candidates = [
    path.join(localApps, 'Microsoft', 'WindowsApps', 'winget.exe'),
    'C:\\Program Files\\WindowsApps\\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\\winget.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

function localUrl(port) {
  return `http://127.0.0.1:${port || DEFAULT_PORT}`;
}

function checkHealth(port) {
  return new Promise(resolve => {
    const req = http.get(`${localUrl(port)}/health`, { timeout: 1500 }, res => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function status(port) {
  const venv = fs.existsSync(VENV_PY());
  const serverPy = fs.existsSync(SERVER_PY());
  const running = await checkHealth(port);
  return { deployed: venv && serverPy, running };
}

// ---------------- 部署 ----------------

/**
 * 一键部署：找 Python（缺失时 winget 安装）→ 建 venv → 国内镜像装依赖 → 写 server.py → 启动 → 等健康。
 * @param {object} opts
 * @param {(step:{type:'step'|'progress'|'done'|'error', message?:string}) => void} [opts.onProgress]
 */
async function deploy(opts = {}) {
  const onProgress = opts.onProgress || (() => {});
  const base = BASE();
  fs.mkdirSync(base, { recursive: true });

  // 1) Python（funasr/torch 生态要求 3.8-3.11；3.12+ 缺 wheel 会被自动排除）
  let python = await findPython();
  if (!python) {
    if (process.platform === 'win32') {
      const winget = wingetExe();
      if (winget !== null) {
        onProgress({ type: 'step', message: '未检测到兼容的 Python（需 3.8-3.11），正在通过 winget 自动安装 Python 3.11…' });
        await tryRunAsync(winget, ['install', '-e', '--id', 'Python.Python.3.11', '--silent', '--accept-package-agreements', '--accept-source-agreements'], { timeout: 900000 });
        python = await findPython();
      }
    }
    if (!python) {
      throw new Error(
        process.platform === 'win32'
          ? '未检测到 Python 3.8-3.11，且自动安装不可用。请手动安装 Python 3.11（https://www.python.org/downloads/release/python-3119/ ，安装时勾选 "Add Python to PATH"），完成后重试一键部署。'
          : '未检测到 Python 3.8-3.11。请在 macOS 上安装（brew install python@3.11），完成后重试一键部署。'
      );
    }
  }
  onProgress({ type: 'step', message: 'Python: ' + python });

  // 2) venv（版本不兼容的旧 venv 自动重建，避免用 3.12+ 继续失败）
  if (fs.existsSync(VENV_PY()) && !pythonOk(await versionOfAsync(VENV_PY()))) {
    onProgress({ type: 'step', message: '旧虚拟环境 Python 版本不兼容，重建中…' });
    try {
      fs.rmSync(path.join(base, 'venv'), { recursive: true, force: true });
    } catch (e) {
      throw new Error('清理旧虚拟环境失败: ' + e.message);
    }
  }
  if (!fs.existsSync(VENV_PY())) {
    onProgress({ type: 'step', message: '创建独立虚拟环境…' });
    const r = await tryRunAsync(python, ['-m', 'venv', path.join(base, 'venv')], { timeout: 300000 });
    if (!r.ok) throw new Error('创建虚拟环境失败: ' + r.out);
  }

  const venvPy = VENV_PY();

  const funasrInstalled =
    process.platform === 'win32'
      ? fs.existsSync(path.join(base, 'venv', 'Lib', 'site-packages', 'funasr'))
      : fs.existsSync(path.join(base, 'venv', 'lib')) &&
        fs.existsSync(path.join(base, 'venv', 'lib', 'python3.11', 'site-packages', 'funasr')) ||
        fs.existsSync(path.join(base, 'venv', 'lib', 'python3.10', 'site-packages', 'funasr')) ||
        fs.existsSync(path.join(base, 'venv', 'lib', 'python3.9', 'site-packages', 'funasr')) ||
        fs.existsSync(path.join(base, 'venv', 'lib', 'python3.8', 'site-packages', 'funasr'));
  // 3) 依赖（流式实时进度 + 多源自动回退 + 安装后导入验证）
  if (!fs.existsSync(SERVER_PY()) || !funasrInstalled) {
    const relay = pipProgressRelay(onProgress);
    const TSINGHUA = ['-i', 'https://pypi.tuna.tsinghua.edu.cn/simple'];
    onProgress({ type: 'step', message: '升级 pip（清华镜像，失败自动回退官方源）…' });
    try {
      await pipInstallWithFallback(venvPy, ['--upgrade', 'pip'], [TSINGHUA], relay, 300000);
    } catch (e) {
      throw new Error('pip 升级失败: ' + e.message);
    }
    onProgress({ type: 'step', message: '安装 CPU 版 PyTorch（官方 CPU 源，失败自动回退清华源/官方源）…' });
    try {
      await pipInstallWithFallback(
        venvPy,
        ['torch', 'torchaudio'],
        [['--index-url', 'https://download.pytorch.org/whl/cpu'], TSINGHUA],
        relay,
        3600000,
      );
    } catch (e) {
      throw new Error('PyTorch 安装失败: ' + e.message);
    }
    // 安装后验证 torch 可导入（防止半截安装被误判成功）
    const torchCheck = await tryRunAsync(venvPy, ['-c', 'import torch; print(torch.__version__)'], { timeout: 120000 });
    if (!torchCheck.ok) {
      throw new Error('PyTorch 安装后验证失败（import torch 出错）: ' + tailLines(torchCheck.out, 5));
    }
    onProgress({ type: 'step', message: 'PyTorch 就绪，安装 FunASR（清华镜像，失败自动回退官方源，约几分钟）…' });
    try {
      await pipInstallWithFallback(venvPy, ['funasr', 'modelscope'], [TSINGHUA], relay, 1800000);
    } catch (e) {
      throw new Error('FunASR 安装失败: ' + e.message);
    }
  }

  // 4) 服务脚本
  onProgress({ type: 'step', message: '写入 ASR 服务脚本…' });
  fs.writeFileSync(SERVER_PY(), SERVER_PY_SOURCE, 'utf8');

  // 5) 启动
  onProgress({ type: 'step', message: '启动服务（首次启动会自动下载 Paraformer-large 模型，约 1GB，请耐心等待）…' });
  await start(onProgress);
  return { ok: true };
}

/** 读取服务日志尾部（启动失败诊断用）。 */
function readLogTail(maxChars) {
  try {
    const text = fs.readFileSync(SERVER_LOG(), 'utf8');
    const lines = text.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    return lines.slice(-12).join(' | ').slice(-maxChars);
  } catch (e) {
    return '';
  }
}

async function start(onProgress) {
  const base = BASE();
  fs.mkdirSync(base, { recursive: true });
  if (!fs.existsSync(VENV_PY()) || !fs.existsSync(SERVER_PY())) {
    throw new Error('尚未部署：请先执行一键部署');
  }
  if (await checkHealth(DEFAULT_PORT)) return { ok: true, already: true };
  const logFd = fs.openSync(SERVER_LOG(), 'a');
  const child = spawn(VENV_PY(), [SERVER_PY()], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, DSH_FUNASR_PORT: String(DEFAULT_PORT), PYTHONUNBUFFERED: '1' },
    windowsHide: true,
  });
  child.unref();
  // 等健康（首次启动自动下载 Paraformer-large 模型约 1GB，最多等 30 分钟）
  const deadline = Date.now() + 30 * 60 * 1000;
  const startedAt = Date.now();
  while (Date.now() < deadline) {
    if (await checkHealth(DEFAULT_PORT)) return { ok: true };
    const waitedMin = Math.floor((Date.now() - startedAt) / 60000);
    if (onProgress) {
      onProgress({ type: 'progress', message: '等待服务就绪（模型下载/加载中，已等待 ' + waitedMin + ' 分钟）…' });
    }
    await new Promise(r => setTimeout(r, 3000));
    // 进程提前退出 → 立即失败并给出日志诊断
    if (child.exitCode !== null) {
      break;
    }
  }
  const log = readLogTail(600);
  throw new Error(
    '服务启动失败/超时（30 分钟）。' + (log !== '' ? '日志尾部：' + log : '请查看日志: ' + SERVER_LOG())
  );
}

async function stop() {
  if (!(await checkHealth(DEFAULT_PORT))) return { ok: true, already: false };
  // 找到监听 10095 的进程并结束
  try {
    if (process.platform === 'win32') {
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const out = await runAsync(ps, ['-NoProfile', '-Command', `(Get-NetTCPConnection -LocalPort ${DEFAULT_PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { timeout: 20000 });
      const pid = parseInt(out.trim(), 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          await runAsync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { timeout: 20000 });
        } catch (e) {
          /* ignore */
        }
      }
    } else {
      // macOS：lsof 找到监听进程并 kill
      const out = await runAsync('/usr/sbin/lsof', ['-ti', `tcp:${DEFAULT_PORT}`], { timeout: 20000 });
      const pid = parseInt(String(out || '').trim().split(/\s+/)[0], 10);
      if (Number.isFinite(pid) && pid > 0) {
        try {
          await runAsync('/bin/kill', ['-TERM', String(pid)], { timeout: 20000 });
        } catch (e) {
          /* ignore */
        }
      }
    }
  } catch (e) {
    /* ignore */
  }
  return { ok: true };
}

module.exports = { status, deploy, start, stop, checkHealth, localUrl, BASE, DEFAULT_PORT };
