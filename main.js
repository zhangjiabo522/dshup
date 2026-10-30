// main.js — DeepSeek Harness Windows 客户端（Electron 主进程）
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrap, clientBaseDir, APP_URL } = require('./bootstrap');
const {
  RELEASES_URL,
  isTrustedPageUrl,
  linuxAutostartPath,
  createLinuxAutostart,
  linuxAutostartEnabled,
  releaseUpdateInfo,
} = require('./desktop-platform');

// 显式指定 userData（Chromium 缓存 / GPU 缓存 / localStorage 落点）：
// 安装版默认会按 productName 建目录（含空格），存在首次创建失败风险；
// 统一放到无空格的私有目录，确保始终可写。
app.setPath(
  'userData',
  path.join(clientBaseDir(), 'user-data')
);

// 冒烟测试用独立 userData：与正在运行的客户端共享 Chromium 配置目录会互相抢锁，
// 导致渲染进程起不来（表现为页面永不加载、窗口随 window-all-closed 静默退出）。
if (process.argv.includes('--smoke-test')) {
  app.setPath('userData', path.join(process.env.XDG_CONFIG_HOME || os.tmpdir(), `dsh-smoke-user-data-${process.pid}`));
}

// 硬件加速开关：必须在 app ready 之前读取设置并调用（关闭 GPU 可显著省内存，部分老旧显卡可修复花屏）
try {
  if (JSON.parse(fs.readFileSync(
    path.join(clientBaseDir(), 'client-settings.json'),
    'utf8',
  )).hardwareAcceleration === false) {
    app.disableHardwareAcceleration();
    console.log('[main] 硬件加速已按设置关闭');
  }
} catch (e) {
  /* 无设置文件或读取失败：保持默认开启 */
}

const SPLASH = path.join(__dirname, 'renderer', 'index.html');
const SETTINGS_PAGE = path.join(__dirname, 'renderer', 'settings.html');

// 客户端本地设置文件（Windows LOCALAPPDATA / macOS Application Support / Linux XDG）
function clientSettingsFile() {
  return path.join(clientBaseDir(), 'client-settings.json');
}

function linuxAutostartFile() {
  return linuxAutostartPath();
}

function setAutoStartLinux(enable) {
  const file = linuxAutostartFile();
  if (!enable) {
    try {
      fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    autoStartRegCache = { at: Date.now(), value: false };
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const desktop = createLinuxAutostart({
    executable: process.execPath,
    appPath: app.isPackaged ? null : app.getAppPath(),
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });
  fs.writeFileSync(file, desktop, 'utf8');
  autoStartRegCache = { at: Date.now(), value: true };
}

// 注册表探测结果缓存 30 秒：readClientSettings 每次点击都会调用，reg 查询是
// 同步阻塞调用，绝不能每个开关点击都付一次注册表查询延迟。
let autoStartRegCache = { at: 0, value: false };
function autoStartRegExists() {
  if (Date.now() - autoStartRegCache.at < 30000) return autoStartRegCache.value;
  let found = false;
  if (process.platform === 'win32') {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DeepSeek Harness'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
      found = /DeepSeek Harness/.test(out);
    } catch (e) {
      found = false;
    }
  } else if (process.platform === 'linux') {
    try {
      found = linuxAutostartEnabled(fs.readFileSync(linuxAutostartFile(), 'utf8'));
    } catch {
      found = false;
    }
  } else if (process.platform === 'darwin') {
    try {
      found = app.getLoginItemSettings().openAtLogin;
    } catch {
      found = false;
    }
  }
  autoStartRegCache = { at: Date.now(), value: found };
  return found;
}

function readClientSettings() {
  // 未保存过时：开机自启默认沿用注册表现状，其余用默认值
  const defaults = {
    autoStart: autoStartRegExists(),
    stopDshOnQuit: true,
    notifyOnComplete: false,
    closeToTray: false, // 关闭窗口时最小化到系统托盘（而非退出）
    launchMinimized: false, // 启动后自动最小化到任务栏
    hardwareAcceleration: true, // GPU 加速（关闭可省内存，重启生效）
    mirror: 'npmmirror', // 依赖下载镜像：npmmirror（国内）| official（官方源）
    proxyMode: 'auto', // 网络模式：auto（自动检测系统代理）| direct（直连，不走代理）
    autoUpdateCheck: true, // 启动时静默检查新版本
  };
  try {
    const raw = fs.readFileSync(clientSettingsFile(), 'utf8');
    const settings = { ...defaults, ...JSON.parse(raw) };
    if (process.platform === 'linux') settings.autoStart = defaults.autoStart;
    return settings;
  } catch (e) {
    return defaults;
  }
}

function writeClientSettings(patch) {
  const next = { ...readClientSettings(), ...patch };
  fs.mkdirSync(path.dirname(clientSettingsFile()), { recursive: true });
  fs.writeFileSync(clientSettingsFile(), JSON.stringify(next, null, 2));
  return next;
}

// dsh 用户全局提示词文件：$DSH_HOME/AGENTS.md —— dsh 每次对话自动注入到系统提示词后面
function instructionsFile() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'AGENTS.md');
}

function readInstructions() {
  try {
    return fs.readFileSync(instructionsFile(), 'utf8');
  } catch (e) {
    return '';
  }
}

function writeInstructions(content) {
  const file = instructionsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

// ---------------- AGENTS.md 结构化内容（偏好块 + 记忆块 + 自由提示词） ----------------

const PREF_OPEN = '<!-- dshup:preferences -->';
const PREF_CLOSE = '<!-- /dshup:preferences -->';
const MEM_OPEN = '<!-- dshup:memory -->';
const MEM_CLOSE = '<!-- /dshup:memory -->';

/** 记忆机制指引（开关打开时注入，指示 AI 自主维护记忆块并每次会话先读取）。
 *  注意：指引文字中不出现块标记的字面量，避免解析时误匹配。 */
const MEMORY_GUIDE = [
  '## 记忆机制（dshup 客户端）',
  '每次新会话开始时，先读取本文件（%DSH_HOME%/AGENTS.md）中标记为 dshup:memory 的注释块内容，并遵循其中记录的用户偏好。',
  '当你在对话中发现用户表达的重要偏好、习惯或个人信息（如喜欢的编程语言、代码风格、称呼方式、常用工具、工作流程）时，用文件工具（read + str_replace_editor）读取本文件，并在该记忆块内追加或更新一条记忆：每条一行、简洁明确、不重复已有条目。',
  '',
].join('\n');

/** 从块标记中提取内容。取最后一个 open（指引文字可能提到标记字样，真实块才是最后的）。 */
function extractBlock(doc, open, close) {
  const start = doc.lastIndexOf(open);
  if (start < 0) return '';
  const bodyStart = start + open.length;
  const end = doc.indexOf(close, bodyStart);
  if (end < 0) return '';
  return doc.slice(bodyStart, end).replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');
}

/** 移除块及其首尾空行，返回剩余自由内容。 */
function removeBlock(doc, open, close) {
  const start = doc.lastIndexOf(open);
  if (start < 0) return doc;
  const end = doc.indexOf(close, start);
  if (end < 0) return doc;
  const before = doc.slice(0, start);
  const after = doc.slice(end + close.length);
  return (before.replace(/\s+$/, '') + '\n' + after.replace(/^\s+/, '')).replace(/\n{3,}/g, '\n\n').trim();
}

/** 移除记忆机制指引段落（以标题开头、到段落结束）。 */
function stripGuide(doc) {
  const idx = doc.indexOf('## 记忆机制（dshup 客户端）');
  if (idx < 0) return doc;
  const rest = doc.slice(idx);
  const end = rest.indexOf('\n\n');
  const cutTo = end >= 0 ? idx + end : doc.length;
  return (doc.slice(0, idx) + doc.slice(cutTo)).replace(/\n{3,}/g, '\n\n').trim();
}

/** 组装完整 AGENTS.md 内容。 */
function renderAgentsDoc(parts) {
  const sections = [];
  if (parts.preferences && parts.preferences.trim() !== '') {
    sections.push(PREF_OPEN + '\n' + parts.preferences.trim() + '\n' + PREF_CLOSE);
  }
  if (parts.memoryEnabled && parts.memory && parts.memory.trim() !== '') {
    sections.push(MEM_OPEN + '\n' + parts.memory.trim() + '\n' + MEM_CLOSE);
  }
  if (parts.memoryEnabled) {
    sections.push(MEMORY_GUIDE);
  }
  if (parts.freePrompt && parts.freePrompt.trim() !== '') {
    sections.push(parts.freePrompt.trim());
  }
  return sections.join('\n\n') + '\n';
}

/** 读取 AGENTS.md 并解析为结构化内容。 */
function readAgentsDoc() {
  const doc = readInstructions();
  const preferencesText = extractBlock(doc, PREF_OPEN, PREF_CLOSE).trim();
  const memory = extractBlock(doc, MEM_OPEN, MEM_CLOSE).trim();
  const memoryEnabled = doc.indexOf(MEM_OPEN) >= 0 && /记忆机制（dshup 客户端）/.test(doc);
  const freePrompt = stripGuide(removeBlock(removeBlock(doc, MEM_OPEN, MEM_CLOSE), PREF_OPEN, PREF_CLOSE)).trim();
  // 记忆内容在关闭时保留在客户端设置中，便于重新开启后恢复
  const saved = readClientSettings().prefs || {};
  return {
    file: instructionsFile(),
    freePrompt,
    preferences: preferencesFromText(preferencesText),
    preferencesText,
    memory: memory || saved.memory || '',
    memoryEnabled,
  };
}

/** 迁移旧版 AGENTS.md（指引中含字面块标记的版本）为新格式。 */
function migrateAgentsDoc() {
  try {
    const file = instructionsFile();
    if (!fs.existsSync(file)) return;
    const doc = readInstructions();
    // 旧版特征：指引段落里出现字面块标记（与新格式的"标记为 dshup:memory 的注释块"描述不同）
    const guideIdx = doc.indexOf('## 记忆机制（dshup 客户端）');
    const hasOldGuide = guideIdx >= 0 && doc.indexOf('`<!-- dshup:memory -->`', guideIdx) >= 0;
    if (!hasOldGuide) return;
    const parsed = readAgentsDoc();
    writeInstructions(renderAgentsDoc({
      freePrompt: parsed.freePrompt,
      preferences: parsed.preferencesText,
      memory: parsed.memory,
      memoryEnabled: parsed.memoryEnabled,
    }));
    console.log('[prefs] 已迁移旧版 AGENTS.md 格式');
  } catch (e) {
    console.error('[prefs] AGENTS.md 迁移失败:', e.message);
  }
}

/** 偏好块文本 → 结构化对象（`- 回答语言：中文` 行）。 */
function preferencesFromText(text) {
  const result = { language: '', style: '' };
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /-\s*([^：:]+)[：:]\s*(.+)/.exec(line.trim());
    if (!m) continue;
    const key = m[1].trim();
    const value = m[2].trim();
    if (key === '回答语言') result.language = value;
    if (key === '回答风格') result.style = value;
  }
  return result;
}

/** 偏好对象 → 块文本。 */
function preferencesToText(prefs) {
  if (!prefs) return '';
  const rows = [];
  const labels = { language: '回答语言', style: '回答风格' };
  for (const key of ['language', 'style']) {
    const value = prefs[key];
    if (value && value !== '' && value !== 'default') rows.push(`- ${labels[key]}：${value}`);
  }
  return rows.join('\n');
}

// 开机自启注册表操作
function setAutoStartReg(enable) {
  const { execFileSync } = require('child_process');
  const runKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const value = `"${process.execPath}" --autostart`;
  if (enable) {
    execFileSync('reg.exe', ['add', runKey, '/v', 'DeepSeek Harness', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true, timeout: 8000 });
  } else {
    try {
      execFileSync('reg.exe', ['delete', runKey, '/v', 'DeepSeek Harness', '/f'], { windowsHide: true, timeout: 8000 });
    } catch (e) {
      /* 键不存在时忽略 */
    }
  }
  // 写注册表后同步缓存，避免 30 秒内读设置仍返回旧值
  autoStartRegCache = { at: Date.now(), value: !!enable };
}

const SMOKE = process.argv.includes('--smoke-test'); // 无人工验证模式：加载成功即退出
const AUTO_START = process.argv.includes('--autostart');

let win = null;
let bootResult = null; // { url, alreadyRunning, process, stop }
let booting = false;
let userOpened = false; // 自启模式下用户是否主动打开过窗口
let settingsRequested = process.argv.includes('--settings');
let quitting = false; // 真正退出（托盘退出按钮置位，避免 closeToTray 拦截）
let tray = null; // 系统托盘图标（常驻：关闭到托盘后从托盘恢复）
let lastBootError = '';
let bootHistory = [];
let bootLogStream = null;
let pageLoadSerial = 0;
let fatalRecovery = null;

// 自启模式日志（便于排查）
function autoLog(line) {
  if (!AUTO_START) return;
  try {
    const dir = clientBaseDir();
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'autostart.log'), `[${new Date().toLocaleString()}] ${line}\n`);
  } catch (e) {
    /* ignore */
  }
}

// 单实例：重复打开时聚焦已有窗口
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', handleSecondInstance);
}

function handleSecondInstance(_event, commandLine = []) {
  showWindow(commandLine.includes('--settings'));
}

// 首次正常启动（打包版）时注册开机自启：Windows 写 HKCU Run 键 / macOS 用 launchd（Electron API）
function ensureAutoStart() {
  try {
    if (!app.isPackaged || AUTO_START || SMOKE) return;
    if (readClientSettings().autoStart) {
      if (process.platform === 'darwin') {
        const settings = app.getLoginItemSettings();
        if (!settings.openAtLogin) {
          app.setLoginItemSettings({ openAtLogin: true, openAsHidden: false, args: ['--autostart'] });
        }
      } else if (process.platform === 'linux') {
        setAutoStartLinux(true);
      } else {
        setAutoStartReg(true);
      }
    }
  } catch (e) {
    console.error('[autostart] 注册失败:', e.message);
  }
}

function send(type, payload) {
  const event = { type, ...(payload || {}) };
  if (['phase', 'status', 'progress', 'server', 'log', 'error', 'fatal'].includes(type)) {
    if (type === 'phase' && payload?.message === 'checking') bootHistory = [];
    bootHistory.push(event);
    if (bootHistory.length > 400) bootHistory.shift();
    if (event.message && type !== 'progress') {
      try {
        if (!bootLogStream) {
          fs.mkdirSync(clientBaseDir(), { recursive: true });
          const file = path.join(clientBaseDir(), 'startup.log');
          if (fs.existsSync(file) && fs.statSync(file).size > 2 * 1024 * 1024) fs.renameSync(file, file + '.1');
          bootLogStream = fs.createWriteStream(file, { flags: 'a', mode: 0o600 });
          bootLogStream.on('error', () => { bootLogStream = null; });
        }
        const line = String(event.message).replace(/([?&]token=)[^\s\x1b]+/g, '$1[已隐藏]');
        bootLogStream.write(`[${new Date().toISOString()}] ${type}: ${line}\n`);
      } catch {}
    }
  }
  if (win && !win.isDestroyed()) {
    win.webContents.send('boot-event', event);
  }
}

async function showStartupFailure(error) {
  lastBootError = error?.message || String(error || '服务未能正常启动，请查看日志后重试。');
  clearTimeout(renderRetryTimer);
  pageLoadSerial += 1;
  send('fatal', { message: lastBootError });
  if (!win || win.isDestroyed() || settingsRequested) return;
  if (win.webContents.getURL() === require('url').pathToFileURL(SPLASH).href) return;
  if (!fatalRecovery) {
    fatalRecovery = win.loadFile(SPLASH).catch(() => {}).finally(() => { fatalRecovery = null; });
  }
  await fatalRecovery;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    backgroundColor: '#0d1117',
    frame: false, // 无边框：使用自定义平滑标题栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(settingsRequested ? SETTINGS_PAGE : SPLASH);

  // Ctrl+, 打开 dshup 客户端设置页（不是官方 dsh 网页设置）
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const comma = input.key === ',' || input.code === 'Comma';
    if (comma && (input.control || input.meta) && !input.alt && !input.shift) {
      event.preventDefault();
      settingsRequested = true;
      if (win && !win.isDestroyed()) win.loadFile(SETTINGS_PAGE);
    }
  });

  // 页面缩放保持用户可控：Ctrl+滚轮 / Ctrl+加号减号 等比缩放（长页面可缩小后完整显示），Ctrl+0 复位
  // 不做任何锁定；每次加载新页面时复位到 100%，避免残留缩放
  win.webContents.on('did-finish-load', () => {
    if (win.webContents.getURL() === require('url').pathToFileURL(SPLASH).href) {
      for (const event of bootHistory) win.webContents.send('boot-event', event);
    }
    try {
      if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1);
    } catch (e) {
      /* ignore */
    }
  });

  // 窗口最大化状态变化 → 通知渲染进程切换 最大化/还原 图标
  win.on('maximize', () => send('maximized-changed', true));
  win.on('unmaximize', () => send('maximized-changed', false));

  // 关闭到托盘：真正退出（托盘菜单"退出"/before-quit）除外
  win.on('close', (e) => {
    if (!quitting && readClientSettings().closeToTray) {
      e.preventDefault();
      win.hide();
      autoLog('关闭到托盘');
    }
  });

  // 启动后自动最小化
  if (readClientSettings().launchMinimized && !SMOKE && !settingsRequested) {
    win.once('ready-to-show', () => {
      try { win.minimize(); } catch (err) { /* ignore */ }
    });
  }

  if (SMOKE) {
    // 冒烟测试：内嵌页加载成功即退出（exit 0），超时/失败退出（exit 1）
    const shotIdx = process.argv.indexOf('--screenshot');
    const shotPath = shotIdx >= 0 ? process.argv[shotIdx + 1] : null;
    const checkTitlebar = process.argv.includes('--check-titlebar');
    const checkSettings = process.argv.includes('--check-settings');
    const checkStats = process.argv.includes('--check-stats');
    const checkVoice = process.argv.includes('--check-voice');
    const checkPrefs = process.argv.includes('--check-prefs');

    if (checkPrefs) {
      // 新个性化/通知功能验证：设置项存在性 + instructions 结构化往返（结束后恢复）
      win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) return;
        setTimeout(async () => {
          try {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              // 打开设置
              let settingsBtn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '设置');
              if (!settingsBtn) {
                const open = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('打开侧边栏'));
                if (open) open.click();
                await sleep(1200);
                settingsBtn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '设置');
              }
              if (settingsBtn) settingsBtn.click();
              await sleep(1500);
              const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
              if (!dialog) return { dialog: false };
              const bodyText = dialog.textContent || '';
              // 系统设置
              const systemNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '系统设置');
              let systemInfo = null;
              if (systemNav) { systemNav.click(); await sleep(600); const st = dialog.textContent || ''; systemInfo = { hasNotify: /任务完成时发送系统通知/.test(st), hasAutoStart: /开机自动启动/.test(st), hasStop: /关闭客户端时停止/.test(st), hasTray: /最小化到托盘/.test(st), hasMirror: /下载镜像/.test(st), hasProxy: /网络模式/.test(st), hasUpdate: /检查更新/.test(st), hasAccel: /硬件加速/.test(st) }; }
              // 个性化
              const personalNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '个性化');
              let personalInfo = null;
              if (personalNav) { personalNav.click(); await sleep(600); const pt = dialog.textContent || ''; personalInfo = { hasLanguage: /回答语言/.test(pt), hasStyle: /回答风格/.test(pt), hasMemory: /记忆功能/.test(pt), hasClear: /清空记忆/.test(pt), hasSave: /保存全部个性化设置/.test(pt) }; }
              // 数据与存储（目录体积统计异步较慢，轮询等待渲染）
              const dataNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '数据与存储');
              let dataInfo = null;
              if (dataNav) { dataNav.click(); let dt = ''; for (let i = 0; i < 8; i++) { await sleep(1500); dt = dialog.textContent || ''; if (/运行时依赖目录/.test(dt)) break; } dataInfo = { hasRuntime: /运行时依赖目录/.test(dt), hasClear: /清理浏览器缓存/.test(dt), hasExport: /导出设置/.test(dt), hasImport: /导入设置/.test(dt) }; }
              // 插件市场（插件列表经 GitHub API 异步加载，轮询等待）
              const marketNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '插件市场');
              let marketInfo = null;
              if (marketNav) { marketNav.click(); let mt = ''; for (let i = 0; i < 8; i++) { await sleep(1500); mt = dialog.textContent || ''; if (/交给 AI 安装/.test(mt) || /插件列表获取失败/.test(mt)) break; } marketInfo = { hasMirror: /下载镜像/.test(mt), hasSpeedtest: /测速/.test(mt), hasList: /插件列表/.test(mt), hasInstall: /一键安装/.test(mt), hasAi: /交给 AI 安装/.test(mt), hasSearch: /搜索/.test(mt), hasPager: /下一页/.test(mt), hasMine: /我的插件/.test(mt), hasUninstall: /卸载/.test(mt) }; }
              // 关于
              const aboutNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '关于');
              let aboutInfo = null;
              if (aboutNav) { aboutNav.click(); await sleep(600); const at = dialog.textContent || ''; aboutInfo = { hasProduct: /桌面客户端/.test(at), hasUpdate: /检查更新/.test(at), hasLinks: /项目仓库/.test(at) }; }
              return { dialog: true, systemInfo, personalInfo, dataInfo, marketInfo, aboutInfo };
            })()`);
            console.log('[prefs-check] ' + JSON.stringify(result));
            try {
              fs.writeFileSync(path.join(os.tmpdir(), 'dsh-prefs-check.json'), JSON.stringify(result, null, 2));
            } catch (e) {
              /* ignore */
            }
            // instructions 结构化往返（保存后恢复原状）
            let orig = '';
            try {
              orig = fs.readFileSync(path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'AGENTS.md'), 'utf8');
            } catch (e) {
              orig = '';
            }
            const before = readAgentsDoc();
            writeInstructions(renderAgentsDoc({ freePrompt: before.freePrompt, preferences: '- 回答语言：中文\n- 回答风格：简洁', memory: '- 测试记忆', memoryEnabled: true }));
            const after = readAgentsDoc();
            console.log('[prefs-roundtrip] ' + JSON.stringify({ preferences: after.preferences, memory: after.memory, memoryEnabled: after.memoryEnabled }));
            // 恢复
            fs.writeFileSync(before.file, orig, 'utf8');
            app.exit(0);
          } catch (e) {
            console.error('[prefs-check] failed: ' + e.message);
            app.exit(1);
          }
        }, 4000);
      });
      setTimeout(() => {
        console.error('[smoke] TIMEOUT');
        app.exit(1);
      }, 120000);
      return;
    }

    if (checkVoice) {
      // 语音输入验证：按钮位置（上下文圈圈与发送按钮之间）+ 设置面板"语音输入"tab + asr 配置往返
      win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) return;
        setTimeout(async () => {
          try {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              // 输入栏里的语音按钮位置
              const voiceBtn = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === '语音输入');
              let position = null;
              if (voiceBtn) {
                const parent = voiceBtn.parentElement;
                const kids = parent ? [...parent.children] : [];
                const idx = kids.indexOf(voiceBtn);
                const labels = kids.map((k) => (k.getAttribute && k.getAttribute('aria-label')) || k.className || '').map((s) => String(s).slice(0, 20));
                position = { idx, total: kids.length, siblings: labels };
              }
              // 打开设置面板找"语音输入" tab（侧边栏收起时先展开）
              let voiceTab = false;
              let voiceSectionInfo = null;
              let settingsBtn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '设置');
              if (!settingsBtn) {
                const open = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('打开侧边栏'));
                if (open) open.click();
                await sleep(1200);
                settingsBtn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '设置');
              }
              if (settingsBtn) settingsBtn.click();
              await sleep(1500);
              const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
              if (dialog) {
                voiceTab = [...dialog.querySelectorAll('button')].some((x) => (x.textContent || '').trim() === '语音输入');
                // 切到语音输入 section：本地模式卡片 → 检查一键部署按钮与状态
                const voiceNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '语音输入');
                if (voiceNav) {
                  voiceNav.click();
                  await sleep(800);
                  const localCard = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').includes('本地部署'));
                  if (localCard) localCard.click();
                  await sleep(800);
                  const bodyText = dialog.textContent || '';
                  voiceSectionInfo = {
                    hasDeployBtn: /一键部署本地模型/.test(bodyText),
                    hasNotDeployed: /本地模型未部署/.test(bodyText),
                    hasLocalUrlField: /本地服务地址/.test(bodyText),
                  };
                }
              }
              // asr 配置往返（含本地状态）
              const cfgRound = await window.dshClient.asr.config.get().then((c) => ({ mode: c.mode, model: c.model, ok: true })).catch((e) => ({ ok: false, err: String(e) }));
              // 未配置引导：默认无 API Key → 按钮应处于"未配置"提示态
              const voiceLabel = (() => {
                const btn = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('语音输入'));
                return btn ? btn.getAttribute('aria-label') : null;
              })();
              // 点击行为验证：配置已保存（remote + key）→ 点击后不应跳转到配置页（URL 保持 3080）
              let clickResult = null;
              const voiceBtnEl = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('语音输入'));
              if (voiceBtnEl) {
                voiceBtnEl.click();
                await sleep(1500);
                clickResult = { url: location.href, label: voiceBtnEl.getAttribute('aria-label') };
              }
              return { voiceBtn: !!voiceBtn, position, voiceTab, voiceSectionInfo, cfgRound, voiceLabel, clickResult };
            })()`);
            console.log('[voice-check] ' + JSON.stringify(result));
            app.exit(0);
          } catch (e) {
            console.error('[voice-check] failed: ' + e.message);
            app.exit(1);
          }
        }, 4000);
      });
      setTimeout(() => {
        console.error('[smoke] TIMEOUT');
        app.exit(1);
      }, 120000);
      return;
    }

    if (checkStats) {
      // 统计页验证（在客户端环境：preload 已暴露 window.dshClient）
      win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) return;
        setTimeout(async () => {
          try {
            const result = await win.webContents.executeJavaScript(`(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              for (let i = 0; i < 15; i++) {
                const btn = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '设置');
                if (btn) { btn.click(); break; }
                const open = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('打开侧边栏'));
                if (open) open.click();
                await sleep(700);
              }
              await sleep(1200);
              const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
              if (!dialog) return { dialog: false };
              const statsTab = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '统计');
              if (!statsTab) return { dialog: true, statsTab: false };
              statsTab.click();
              await sleep(3000);
              const bodyText = dialog.textContent || '';
              const cells = dialog.querySelectorAll('[class*="h1"],[class*="h2"],[class*="h3"],[class*="h4"]').length;
              // 矩形矩阵结构验证：今天(带 today 类)应位于最后一列的第 3 行
              const gridInfo = (() => {
                const todayEl = [...dialog.querySelectorAll('*')].find((el) => el.className && String(el.className).includes('today'));
                if (!todayEl) return { todayFound: false };
                const col = todayEl.parentElement;
                const calendar = col ? col.parentElement : null;
                const colKids = col ? [...col.children] : [];
                return {
                  todayFound: true,
                  todayRow: colKids.indexOf(todayEl), // 应为 2（第 3 行）
                  rowsInCol: colKids.length, // 7
                  totalCols: calendar ? calendar.children.length : -1,
                  lastColIndex: calendar ? [...calendar.children].indexOf(col) : -1,
                  colCountOk: calendar ? [...calendar.children].indexOf(col) === calendar.children.length - 1 : false,
                };
              })();
              return {
                dialog: true,
                statsTab: true,
                hasTotal: /累计 Token/.test(bodyText),
                hasToday: /今日 Token/.test(bodyText),
                hasLongest: /最长任务/.test(bodyText),
                hasTurns: /任务数/.test(bodyText),
                hasSessions: /会话数/.test(bodyText),
                hasComposition: /Token 构成/.test(bodyText) && /输入/.test(bodyText) && /推理/.test(bodyText),
                hasRecent14: /近 14 天/.test(bodyText),
                hasCalendar: /近三个月/.test(bodyText),
                heatCells: cells,
                gridInfo,
              };
            })()`);
            console.log('[stats-check] ' + JSON.stringify(result));
            app.exit(0);
          } catch (e) {
            console.error('[stats-check] failed: ' + e.message);
            app.exit(1);
          }
        }, 4000);
      });
      setTimeout(() => {
        console.error('[smoke] TIMEOUT');
        app.exit(1);
      }, 120000);
      return;
    }

    if (checkSettings) {
      // 设置页专项验证：3080 加载完成后导航到设置页，验证 tab/iframe/自动打开原设置面板
      win.webContents.on('did-finish-load', () => {
        const url = win.webContents.getURL();
        if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
          setTimeout(() => win.loadFile(SETTINGS_PAGE), 800);
        } else if (url.startsWith('file:')) {
          if (!url.includes('settings.html')) return; // 只检查设置页（splash 也是 file:）
          setTimeout(async () => {
            try {
              const tabs = await win.webContents.executeJavaScript(
                `[...document.querySelectorAll('.tab')].map(t => t.dataset.tab)`
              );
              console.log('[settings-page] tabs=' + JSON.stringify(tabs));
              const frameInfo = await win.webContents.executeJavaScript(
                `(() => { const f = document.getElementById('webFrame'); return { hasFrame: !!f, src: f ? f.src : null }; })()`
              );
              console.log('[settings-page] ' + JSON.stringify(frameInfo));
              // 模拟用户点击"网页设置"tab → 自动打开原设置面板
              await win.webContents.executeJavaScript(
                `[...document.querySelectorAll('.tab')].find(t => t.dataset.tab === 'web').click()`
              );
              const sub = win.webContents.mainFrame.framesInSubtree.find((x) => x !== win.webContents.mainFrame);
              let dialog = { polled: true, dialog: false };
              if (sub) {
                dialog = await sub
                  .executeJavaScript(
                    `(async () => {
                      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
                      for (let i = 0; i < 12; i++) {
                        const d = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
                        if (d) return { dialog: true, dialogText: (d.textContent || '').trim().slice(0, 60) };
                        await sleep(1500);
                      }
                      return { dialog: false };
                    })()`
                  )
                  .catch((e) => ({ err: e.message }));
              }
              console.log('[settings-dialog] ' + JSON.stringify(dialog));
              app.exit(0);
            } catch (e) {
              console.error('[settings-page] failed: ' + e.message);
              app.exit(1);
            }
          }, 5000);
        }
      });
      setTimeout(() => {
        console.error('[smoke] TIMEOUT');
        app.exit(1);
      }, 120000);
      return;
    }

    setTimeout(() => {
      console.error('[smoke] TIMEOUT waiting for page');
      app.exit(1);
    }, 120000);
    win.webContents.on('did-finish-load', () => {
      const url = win.webContents.getURL();
      if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
        const finish = async () => {
          console.log('[smoke] OK url=' + url + ' title=' + JSON.stringify(win.webContents.getTitle()));
          if (bootResult && !bootResult.alreadyRunning) await bootResult.stop();
          setTimeout(() => app.exit(0), 600);
        };
        const verify = async () => {
          if (process.env.DSHUP_SMOKE_MARKER) {
            const marker = await win.webContents.executeJavaScript("document.querySelector('[data-dshup-smoke]')?.textContent || ''").catch(() => '');
            if (marker !== process.env.DSHUP_SMOKE_MARKER) {
              console.error('[smoke] 认证后的测试页面未加载');
              app.exit(1);
              return;
            }
          }
          try {
            // 查找 dsh 设置触发按钮（供设置页 iframe 自动打开设置面板使用）
            const settingsBtn = await win.webContents.executeJavaScript(`(() => {
              const btns = [...document.querySelectorAll('button')].map((b) => ({
                text: (b.textContent || '').trim().slice(0, 24),
                aria: b.getAttribute('aria-label') || '',
                title: b.title || '',
                cls: (b.className || '').toString().slice(0, 48),
              }));
              return btns.filter((x) => /设置|setting/i.test(x.text + x.aria + x.title));
            })()`);
            console.log('[settingsbtn] ' + JSON.stringify(settingsBtn));

            // 布局诊断（显示不全排查）
            const layout = await win.webContents.executeJavaScript(`(() => {
              const out = {
                innerW: window.innerWidth, innerH: window.innerHeight,
                dpr: devicePixelRatio,
                docClientW: document.documentElement.clientWidth,
                docScrollW: document.documentElement.scrollWidth,
                docClientH: document.documentElement.clientHeight,
                docScrollH: document.documentElement.scrollHeight,
                zoom: getComputedStyle(document.documentElement).zoom,
              };
              // html/body transform（fixed 定位失效排查）
              out.htmlTransform = getComputedStyle(document.documentElement).transform;
              out.bodyTransform = document.body ? getComputedStyle(document.body).transform : '';
              // 真实滚动容器：scrollHeight 显著大于 clientHeight 的元素
              const scrollers = [];
              for (const el of document.querySelectorAll('*')) {
                if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 0) {
                  scrollers.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,30), scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: getComputedStyle(el).overflowY });
                }
              }
              scrollers.sort((a, b) => b.scrollH - a.scrollH);
              out.scrollers = scrollers.slice(0, 5);
              // dsh header 定位方式
              const header = document.querySelector('._0iycDa_header') || document.querySelector('header');
              out.headerPos = header ? getComputedStyle(header).position : null;
              // 标题栏当前 rect
              const bar = document.getElementById('dsh-win-titlebar');
              out.barTop = bar ? Math.round(bar.getBoundingClientRect().top) : null;
              return out;
            })()`);
            console.log('[layout] ' + JSON.stringify(layout));

            // 滚动最深滚动容器后，检查标题栏是否仍固定在视口顶部
            const afterScroll = await win.webContents.executeJavaScript(`(() => {
              const scrollers = [];
              for (const el of document.querySelectorAll('*')) {
                if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 0) scrollers.push(el);
              }
              scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
              const sc = scrollers[0];
              if (sc) sc.scrollTop = 800;
              const bar = document.getElementById('dsh-win-titlebar');
              return { scrolled: !!sc, barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null, scScrollTop: sc ? sc.scrollTop : null };
            })()`);
            console.log('[scrollfix] ' + JSON.stringify(afterScroll));

            // dsh 根容器结构（body 直接子元素）诊断
            const rootInfo = await win.webContents.executeJavaScript(`(() => {
              const kids = [...document.body.children].map((el) => {
                const r = el.getBoundingClientRect();
                const cs = getComputedStyle(el);
                return { tag: el.tagName, cls: (el.className || '').toString().slice(0, 30), top: Math.round(r.top), h: Math.round(r.height), pos: cs.position, csHeight: cs.height, csOverflow: cs.overflow };
              });
              // 所有带滚动条（overflowY auto/scroll 且内容超高）的元素
              const allScrollbars = [];
              for (const el of document.querySelectorAll('*')) {
                if (el.scrollHeight > el.clientHeight + 20 && el.clientHeight > 0) {
                  const cs = getComputedStyle(el);
                  if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
                    const r = el.getBoundingClientRect();
                    allScrollbars.push({ cls: (el.className || '').toString().slice(0, 30), scrollH: el.scrollHeight, clientH: el.clientHeight, overflowY: cs.overflowY, right: Math.round(r.right), w: Math.round(r.width) });
                  }
                }
              }
              return {
                bodyPadTop: getComputedStyle(document.body).paddingTop,
                bodyOverflow: getComputedStyle(document.body).overflow,
                htmlScroll: { scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight, overflow: getComputedStyle(document.documentElement).overflow },
                bodyScroll: { scrollH: document.body.scrollHeight, clientH: document.body.clientHeight },
                kids,
                allScrollbars,
              };
            })()`);
            console.log('[rootinfo] ' + JSON.stringify(rootInfo));
            console.log('[layout] webContents.zoomFactor=' + win.webContents.getZoomFactor());

            // 缩放能力验证（适应窗口按钮依赖此通道）
            win.webContents.setZoomFactor(0.85);
            await new Promise((r) => setTimeout(r, 300));
            console.log('[zoom] set 0.85 -> get ' + win.webContents.getZoomFactor());
            win.webContents.setZoomFactor(1);
            await new Promise((r) => setTimeout(r, 300));

            // 按钮点击实测：最小化 → 检查窗口状态 → 还原
            await win.webContents.executeJavaScript(
              `(document.querySelector('#dsh-win-titlebar .tb-min')||{}).click && document.querySelector('#dsh-win-titlebar .tb-min').click()`
            );
            await new Promise((r) => setTimeout(r, 900));
            const minimized = win.isMinimized();
            console.log('[btn] minimize click -> isMinimized=' + minimized);
            if (minimized) win.restore();

            // 适应窗口实测：点击 → 检查根容器 transform scale 与 body 高度
            const fitRes = await win.webContents.executeJavaScript(`(() => {
              const btn = document.querySelector('#dsh-win-titlebar .tb-fit');
              if (!btn) return { hasBtn: false };
              btn.click();
              const root = [...document.body.children].find((el) => el.tagName === 'DIV');
              return {
                hasBtn: true,
                rootTransform: root ? root.style.transform : null,
                rootH: root ? root.style.height : null,
                bodyH: document.body.style.height,
                bodyOverflow: document.body.style.overflow,
              };
            })()`);
            console.log('[fit] ' + JSON.stringify(fitRes));

            const diag = await win.webContents.executeJavaScript(`(() => {
              const bar = document.getElementById('dsh-win-titlebar');
              if (!bar) return { injected: false };
              const r = bar.getBoundingClientRect();
              const cs = getComputedStyle(bar);
              const logo = bar.querySelector('.tb-logo');
              const btns = [...bar.querySelectorAll('.tb-btn')].map(b => ({ cls: b.className, title: b.title }));
              // 页面背景与顶部布局探测（用于标题栏融合）
              const bodyBg = getComputedStyle(document.body).backgroundColor;
              const htmlBg = getComputedStyle(document.documentElement).backgroundColor;
              const topProbe = (() => {
                const out = [];
                for (const el of document.querySelectorAll('body *')) {
                  const rr = el.getBoundingClientRect();
                  if (rr.top < 40 && rr.bottom > 8 && rr.width > 150 && rr.height > 0 && out.length < 8) {
                    out.push({ tag: el.tagName, cls: (el.className||'').toString().slice(0,36), top: Math.round(rr.top), bottom: Math.round(rr.bottom) });
                  }
                }
                return out;
              })();
              return {
                injected: true,
                rect: { x: r.x, y: r.y, w: r.width, h: r.height },
                zIndex: cs.zIndex,
                bg: cs.backgroundImage.slice(0, 70),
                region: cs.getPropertyValue('-webkit-app-region'),
                logoLoaded: logo ? (logo.complete && logo.naturalWidth > 0) : false,
                buttons: btns,
                bodyPaddingTop: getComputedStyle(document.body).paddingTop,
                bodyBg, htmlBg,
                topProbe,
              };
            })()`);
            console.log('[titlebar] ' + JSON.stringify(diag));
            try {
              fs.writeFileSync(
                path.join(clientBaseDir(), 'diag-titlebar.json'),
                JSON.stringify(diag, null, 2)
              );
            } catch (e) { /* ignore */ }
            if (checkTitlebar && (!diag || diag.injected !== true)) {
              console.error('[smoke] TITLEBAR MISSING');
              app.exit(1);
              return;
            }
          } catch (e) {
            console.error('[titlebar] diag failed: ' + e.message);
          }
          if (shotPath) {
            try {
              const img = await win.webContents.capturePage();
              require('fs').writeFileSync(shotPath, img.toPNG());
              console.log('[smoke] screenshot saved: ' + shotPath);
            } catch (e) {
              console.error('[smoke] screenshot failed: ' + e.message);
            }
          }
          finish();
        };
        setTimeout(verify, 2500);
      }
    });
  }

  // 外部链接交给系统默认浏览器，保持"客户端内展示"的体验
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });
  const guardNavigation = (event, url) => {
    if (isTrustedPageUrl(url, APP_URL)) return;
    event.preventDefault();
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url).catch(() => {});
  };
  win.webContents.on('will-navigate', guardNavigation);
  win.webContents.on('will-redirect', guardNavigation);

  // dsh 服务意外挂掉时，切回启动页并提示重试
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) => {
    if (code === -3 /* ERR_ABORTED */) return;
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      if (SMOKE) {
        console.error('[smoke] FAILED to load ' + url + ': ' + desc);
        app.exit(1);
      }
      if (isMainFrame !== false && !settingsRequested) {
        void showStartupFailure('无法连接本地服务（' + desc + '）。服务可能已经退出，请查看日志并重试。');
      }
    }
  });

  // 设置页 iframe（内嵌 dsh 页面）：由设置页切到"网页设置"tab 时触发自动打开原设置面板
  win.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
    try {
      const frame = e && e.frame;
      if (isMainFrame) {
        // 语音引导：主窗口回到 dsh 页面后自动打开设置面板并切到"语音输入"
        if (frame && new URL(frame.url).origin === new URL(APP_URL).origin && pendingVoiceSection) {
          setTimeout(() => {
            autoOpenSettingsPanel(frame).then((r) => console.log('[autoopen] main result: ' + r));
          }, 1800);
        }
        return;
      }
      if (frame && new URL(frame.url).origin === new URL(APP_URL).origin) {
        setTimeout(() => {
          autoOpenSettingsPanel(frame).then((r) => console.log('[autoopen] result: ' + r));
        }, 2500);
      }
    } catch (err) {
      /* ignore */
    }
  });
}

async function runBootstrap() {
  if (booting) return false;
  booting = true;
  lastBootError = '';
  try {
    // 若上次由本客户端启动的服务还活着，先停掉，避免重复实例
    if (bootResult && bootResult.stop && !bootResult.alreadyRunning) {
      const previous = bootResult;
      bootResult = null;
      await previous.stop();
    }
    send('phase', { message: 'checking' });
    const authCookies = await require('electron').session.defaultSession.cookies.get({ url: APP_URL });
    bootResult = await bootstrap({
      authCookies: authCookies.map(({ name, value }) => `${name}=${value}`),
      onEvent: (ev) => {
        send(ev.type, ev);
        if (AUTO_START && (ev.type === 'status' || ev.type === 'log' || ev.type === 'error' || ev.type === 'server')) {
          autoLog(ev.message || '');
        }
      },
    });
    // dsh >= 0.2：写入认证 cookie，保证内嵌窗口与 iframe/api 请求都通过认证
    if (!bootResult.alreadyRunning) await installAuthCookies(bootResult.cookies);
    await require('electron').session.defaultSession.cookies.flushStore();
    const running = bootResult;
    if (running.process) {
      const stopped = (code, signal) => {
        if (quitting || SMOKE || bootResult !== running) return;
        bootResult = null;
        void showStartupFailure(`本地服务已退出（${signal || code}），请查看日志并重试。`);
      };
      running.process.once('exit', stopped);
      if (running.process.exitCode !== null || running.process.signalCode !== null) {
        stopped(running.process.exitCode, running.process.signalCode);
        return false;
      }
    }
    // 等待页面首次渲染稳定后再切到内嵌页面
    setTimeout(() => {
      if (win && !win.isDestroyed() && !settingsRequested && bootResult === running) {
        loadDshPage(12);
      }
    }, 500);
    return true;
  } catch (e) {
    const failed = bootResult;
    bootResult = null;
    if (failed && !failed.alreadyRunning) await failed.stop().catch(() => {});
    await showStartupFailure(e);
    if (AUTO_START) autoLog('启动失败: ' + (e.message || e));
    if (SMOKE) {
      console.error('[smoke] BOOTSTRAP FAILED: ' + (e.message || e));
      app.exit(1);
    }
    return false;
  } finally {
    booting = false;
  }
}

// 加载 dsh 页面 + 渲染健康检查：开机自启刚拉起服务时页面可能尚未渲染（黑屏），
// 自动重新加载直到渲染出界面（最多 retries 次）。
let renderRetryTimer = null;

/**
 * dsh >= 0.2 的浏览器认证 cookie：bootstrap 已用 launch token 换到 Set-Cookie，
 * 这里写进 Electron 的 session，内嵌窗口后续所有请求（含 iframe、/api）都自动带上。
 * 只对 127.0.0.1/localhost 生效，不污染其它站点。
 */
async function installAuthCookies(cookies) {
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  const { session } = require('electron');
  for (const raw of cookies) {
    const line = String(raw);
    const [pair] = line.split(';');
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) continue;
    const maxAgeMatch = /max-age=(\d+)/i.exec(line);
    const expiresMatch = /expires=([^;]+)/i.exec(line);
    const cookie = {
      url: APP_URL,
      name,
      value,
      path: /(?:^|;)\s*path=([^;]+)/i.exec(line)?.[1] || '/',
      httpOnly: /httponly/i.test(line),
      sameSite: /samesite=strict/i.test(line) ? 'strict' : /samesite=lax/i.test(line) ? 'lax' : 'unspecified',
    };
    if (maxAgeMatch) cookie.expirationDate = Math.floor(Date.now() / 1000) + Number(maxAgeMatch[1]);
    else if (expiresMatch) {
      const at = Date.parse(expiresMatch[1]);
      if (!Number.isNaN(at)) cookie.expirationDate = Math.floor(at / 1000);
    }
    try {
      await session.defaultSession.cookies.set(cookie);
    } catch (e) {
      throw new Error('无法保存本地服务的登录状态，请重试启动客户端。');
    }
  }
}

function loadDshPage(retriesLeft = 12) {
  if (!win || win.isDestroyed() || settingsRequested) return;
  if (!bootResult) {
    void showStartupFailure(lastBootError || '本地服务尚未启动，请点击重试。');
    return;
  }
  const serial = ++pageLoadSerial;
  const url = bootResult.url;
  clearTimeout(renderRetryTimer);
  win.loadURL(url).then(() => {
    if (serial !== pageLoadSerial || !win || win.isDestroyed() || settingsRequested) return;
    renderRetryTimer = setTimeout(async () => {
      if (serial !== pageLoadSerial || !win || win.isDestroyed() || settingsRequested) return;
      const rendered = await win.webContents.executeJavaScript(`(() => {
        const body = document.body?.cloneNode(true);
        if (!body) return false;
        body.querySelectorAll('#dsh-win-titlebar, script, style').forEach(node => node.remove());
        const text = (body.textContent || '').trim();
        if (/Failed to load plugins/i.test(text)) return 'plugins';
        return body.querySelectorAll('button').length > 3 && text.length > 20 && !text.startsWith('dsh web authentication required');
      })()`).catch(() => false);
      if (serial !== pageLoadSerial || settingsRequested) return;
      if (rendered === true) return;
      if (rendered === 'plugins') {
        await showStartupFailure('插件加载失败，请在客户端设置中检查插件，修复后点击重试。');
      } else if (retriesLeft > 0) {
        send('status', { message: '页面尚未就绪，自动重试中…' });
        loadDshPage(retriesLeft - 1);
      } else {
        await showStartupFailure('页面多次加载仍未就绪，请查看启动日志并重试。');
      }
    }, 2500);
  }).catch(error => {
    if (serial === pageLoadSerial && !settingsRequested) {
      void showStartupFailure('无法打开本地服务：' + (error.message || error));
    }
  });
}

// IPC
ipcMain.on('retry-bootstrap', () => {
  settingsRequested = false;
  if (win && !win.isDestroyed()) win.loadFile(SPLASH);
  setTimeout(() => runBootstrap(), 300);
});

// 自定义标题栏：窗口控制
ipcMain.handle('win-minimize', () => {
  if (win && !win.isDestroyed()) win.minimize();
});
ipcMain.handle('win-toggle-maximize', () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
ipcMain.handle('win-close', () => {
  if (win && !win.isDestroyed()) win.close();
});
ipcMain.handle('win-is-maximized', () => (win && !win.isDestroyed() ? win.isMaximized() : false));

// 页面缩放（"适应窗口"按钮调用）：factor 由渲染层按文档高度计算
ipcMain.handle('win-set-zoom', (_e, factor) => {
  if (win && !win.isDestroyed()) {
    const f = Math.max(0.2, Math.min(2, Number(factor) || 1));
    win.webContents.setZoomFactor(f);
  }
});

ipcMain.handle('open-external', (_e, url) => {
  if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
});

// 设置页导航
ipcMain.handle('open-settings', () => {
  settingsRequested = true;
  if (win && !win.isDestroyed()) win.loadFile(SETTINGS_PAGE);
});
ipcMain.handle('close-settings', () => {
  settingsRequested = false;
  loadDshPage(12);
});

// 设置页"网页设置"tab：对 iframe 里的 dsh 页面自动打开原设置面板
ipcMain.handle('auto-open-settings-panel', async () => {
  try {
    if (!win || win.isDestroyed()) return { ok: false };
    const sub = win.webContents.mainFrame.framesInSubtree.find((x) => x !== win.webContents.mainFrame);
    if (!sub) return { ok: false };
    const result = await autoOpenSettingsPanel(sub);
    return { ok: result === 'clicked', result };
  } catch (e) {
    return { ok: false, result: String(e) };
  }
});

// 客户端本地设置
ipcMain.handle('settings:get', () => {
  const command = app.isPackaged && process.platform === 'linux' ? 'dshup' :
    `"${process.execPath}"${app.isPackaged ? '' : ` "${app.getAppPath()}"`}`;
  return { ...readClientSettings(), startup: { command, settingsCommand: command + ' --settings' } };
});
ipcMain.handle('settings:set', (_e, key, value) => {
  const next = writeClientSettings({ [key]: value });
  if (key === 'autoStart') {
    if (process.platform === 'darwin') {
      app.setLoginItemSettings({ openAtLogin: !!value, openAsHidden: false, args: ['--autostart'] });
    } else if (process.platform === 'linux') {
      setAutoStartLinux(!!value);
    } else {
      setAutoStartReg(!!value);
    }
  }
  return next;
});

// 设置导出/导入（JSON 文件，经系统对话框选择路径）
ipcMain.handle('settings:export', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog(win, {
      title: '导出客户端设置',
      defaultPath: 'dsh-client-settings.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(result.filePath, JSON.stringify(readClientSettings(), null, 2));
    return { ok: true, path: result.filePath };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});
ipcMain.handle('settings:import', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog(win, {
      title: '导入客户端设置',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    const data = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
    if (typeof data !== 'object' || data === null) throw new Error('文件不是有效的设置 JSON');
    const merged = { ...readClientSettings(), ...data };
    fs.writeFileSync(clientSettingsFile(), JSON.stringify(merged, null, 2));
    return { ok: true, settings: merged };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// ---------------- 系统托盘 ----------------

/** 显示/恢复主窗口（窗口被关掉后按启动流程重建）。 */
function showWindow(openSettings = false) {
  userOpened = true;
  settingsRequested = openSettings;
  if (!win || win.isDestroyed()) {
    createWindow();
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  if (settingsRequested) {
    void win.loadFile(SETTINGS_PAGE);
  } else if (bootResult) {
    setTimeout(() => {
      if (win && !win.isDestroyed() && !settingsRequested) loadDshPage(12);
    }, 300);
  }
}

/** 创建常驻托盘图标：左键双击显示窗口，菜单含显示/退出。 */
function createTray() {
  try {
    const { Tray, Menu, nativeImage } = require('electron');
    const raw = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
    tray = new Tray(raw.resize({ width: 16, height: 16 }));
    tray.setToolTip('DeepSeek Harness');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '显示 DeepSeek Harness', click: () => { showWindow(); } },
      {
        label: '客户端设置',
        click: () => { showWindow(true); },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          quitting = true;
          app.quit();
        },
      },
    ]));
    tray.on('double-click', () => { showWindow(); });
  } catch (e) {
    console.error('[tray] 托盘创建失败:', e.message);
  }
}

// ---------------- 更新检查（GitHub Releases） ----------------

/** 查 GitHub 最新 release（直连，超时容错；走代理时失败会返回 error 字段）。结果缓存 10 分钟。 */
let updateCache = { at: 0, data: null };
async function checkUpdate() {
  if (updateCache.data !== null && Date.now() - updateCache.at < 600000) return updateCache.data;
  const current = app.getVersion();
  const base = { current, latest: '', url: RELEASES_URL, hasUpdate: false };
  try {
    const { net } = require('electron');
    const request = net.request({
      url: 'https://api.github.com/repos/zhangjiabo522/dshup/releases/latest',
      headers: { Accept: 'application/vnd.github+json' },
    });
    const body = await new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => {
        finish(new Error('检查更新超时'));
        request.abort();
      }, 10000);
      request.on('response', (res) => {
        if (res.statusCode !== 200) {
          finish(new Error(`检查更新失败（HTTP ${res.statusCode}）`));
          request.abort();
          return;
        }
        res.on('data', chunk => chunks.push(chunk));
        res.on('error', error => finish(error));
        res.on('end', () => finish(null, Buffer.concat(chunks).toString('utf8')));
      });
      request.on('error', error => finish(error));
      try {
        request.end();
      } catch (error) {
        finish(error);
      }
    });
    const data = JSON.parse(body);
    const result = releaseUpdateInfo(data, current);
    if (!result.latest) return base;
    updateCache = { at: Date.now(), data: result };
    return result;
  } catch (e) {
    return { ...base, error: String(e) };
  }
}

ipcMain.handle('update:check', () => checkUpdate());
ipcMain.handle('update:open', async () => {
  const result = await checkUpdate();
  await shell.openExternal(result.url);
});

// ---------------- 插件市场（GitHub topic: dsh-plugin + 国内镜像加速） ----------------

/** 可选下载镜像：直连 + 常见 GitHub 加速代理（测速后前端高亮最快）。 */
const MARKET_MIRRORS = [
  { id: 'direct', name: '直连（github.com）', prefix: '' },
  { id: 'ghfast', name: 'ghfast.top', prefix: 'https://ghfast.top/' },
  { id: 'ghproxy', name: 'gh-proxy.com', prefix: 'https://gh-proxy.com/' },
  { id: 'ghproxy-net', name: 'mirror.ghproxy.com', prefix: 'https://mirror.ghproxy.com/' },
  { id: 'ghdl', name: 'gh.ddlc.top', prefix: 'https://gh.ddlc.top/' },
  { id: 'ghp', name: 'ghp.ci', prefix: 'https://ghp.ci/' },
];

/** 市场列表缓存（GitHub search API 未登录限流，按 查询词+页码 缓存 10 分钟）。 */
const marketListCache = new Map();

/** 带超时的 GET 文本请求（主进程全局 fetch）。 */
async function fetchText(url, timeoutMs = 8000) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dshup-market', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 市场插件列表：GitHub topic:dsh-plugin（按 star 排序，分页 + 关键词搜索）。
 * payload: { query?: string, page?: number }，每页 20 条；直连失败自动经镜像重试。
 * GitHub 搜索 API 上限 1000 条，超过部分标记 hasMore 截断说明。
 */
ipcMain.handle('market:list', async (_e, payload) => {
  const query = payload && typeof payload.query === 'string' ? payload.query.trim() : '';
  const page = payload && Number.isInteger(payload.page) && payload.page >= 1 ? payload.page : 1;
  const perPage = 20;
  const key = `${query}|${page}`;
  const cached = marketListCache.get(key);
  if (cached !== undefined && Date.now() - cached.at < 600000) return cached.data;

  const q = query === '' ? 'topic:dsh-plugin' : `${query} topic:dsh-plugin`;
  const apiUrl = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&page=${page}&per_page=${perPage}`;
  const attempts = [
    { name: '直连', url: apiUrl },
    ...MARKET_MIRRORS.filter(m => m.prefix !== '').map(m => ({ name: m.name, url: m.prefix + apiUrl })),
  ];
  let lastErr = '';
  for (const attempt of attempts) {
    try {
      const text = await fetchText(attempt.url, 10000);
      const data = JSON.parse(text);
      const items = (data.items || []).map(item => ({
        fullName: item.full_name,
        htmlUrl: item.html_url,
        cloneUrl: item.clone_url,
        description: item.description || '',
        stars: item.stargazers_count || 0,
        language: item.language || '',
        defaultBranch: item.default_branch || 'main',
      }));
      const total = data.total_count || 0;
      const capped = Math.min(total, 1000); // GitHub 搜索分页上限
      const result = {
        ok: true,
        source: attempt.name,
        query,
        page,
        perPage,
        total,
        capped,
        totalPages: Math.max(1, Math.ceil(capped / perPage)),
        hasMore: page * perPage < capped,
        items,
      };
      marketListCache.set(key, { at: Date.now(), data: result });
      return result;
    } catch (e) {
      lastErr = e && e.message ? e.message : String(e);
    }
  }
  return {
    ok: false,
    error: `插件列表获取失败（直连与全部镜像均不可用）: ${lastErr}`,
  };
});

/** 镜像测速：经每个镜像拉取一个小文件（dshup 的 package.json），返回延迟（ms）。 */
ipcMain.handle('market:speedtest', async () => {
  // dshup 仓库默认分支为 main（此前误用 master 导致全 404）
  const target = 'https://github.com/zhangjiabo522/dshup/raw/main/package.json';
  const results = [];
  for (const mirror of MARKET_MIRRORS) {
    const url = mirror.prefix === '' ? target : mirror.prefix + target;
    let best = null;
    for (let round = 0; round < 2; round++) {
      const started = Date.now();
      try {
        const text = await fetchText(url, 8000);
        const ms = Date.now() - started;
        if (text.length < 50) throw new Error('响应过短');
        if (best === null || ms < best) best = ms;
      } catch (e) {
        /* 该轮失败 */
      }
    }
    results.push({ id: mirror.id, name: mirror.name, ok: best !== null, ms: best ?? null });
  }
  results.sort((a, b) => {
    if (a.ok && !b.ok) return -1;
    if (!a.ok && b.ok) return 1;
    return (a.ms ?? Infinity) - (b.ms ?? Infinity);
  });
  const fastest = results.find(r => r.ok) ?? null;
  return { ok: true, results, fastest };
});

function buildPluginCommand(args) {
  const { detectCheckout, detectDsh, detectNode } = require('./bootstrap');
  const checkout = detectCheckout();
  const node = detectNode();
  const cliArgs = ['plugin', '--profile', 'web', ...args];
  if (checkout && checkout.dir) {
    if (!node) throw new Error('未找到可用的 Node.js，无法执行插件管理命令');
    return { file: node, args: ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', ...cliArgs], cwd: checkout.dir, node };
  }
  const dshBin = detectDsh();
  if (!dshBin) throw new Error('未找到 dsh 命令：请先通过客户端完成环境准备');
  return { file: dshBin, args: cliArgs, cwd: os.homedir(), node };
}

async function runPluginCommand(plan, sendLine) {
  const { spawn } = require('child_process');
  const { resolveCmd, withSanePath, withRuntimePath, detectNode, detectPnpm, installPnpm } = require('./bootstrap');
  const node = plan.node || detectNode();
  if (!node) throw new Error('未找到可用的 Node.js，无法执行插件管理命令');
  const pnpm = detectPnpm() || await installPnpm(node, (event) => {
    if (event.message) sendLine(event.message);
  });
  const isWin = process.platform === 'win32';
  const env = withRuntimePath(process.env, node);
  env.PATH = [path.dirname(pnpm), env.PATH || ''].join(path.delimiter);
  let bat = null;
  let child;
  if (isWin) {
    const command = [plan.file, ...plan.args].map((value) => `"${String(value).replace(/"/g, '""')}"`).join(' ');
    bat = path.join(os.tmpdir(), `dsh-market-${process.pid}-${Date.now()}.cmd`);
    fs.writeFileSync(bat, '@echo off\r\n' + command + '\r\n', 'utf8');
    child = spawn(resolveCmd(), ['/d', '/c', `"${bat}"`], {
      cwd: plan.cwd,
      env: withSanePath(env),
      windowsHide: false,
      windowsVerbatimArguments: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } else {
    child = spawn(plan.file, plan.args, {
      cwd: plan.cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  }
  return new Promise((resolve, reject) => {
    const onData = buf => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        const clean = line.replace(/\s+$/, '');
        if (clean !== '') sendLine(clean);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', code => {
      if (bat) {
        try { fs.unlinkSync(bat); } catch (e) { /* ignore */ }
      }
      resolve(code);
    });
  });
}

/** 插件安装：`dsh plugin --profile web add <镜像加速的 git 地址>`，异步 + 行级进度。 */
let marketInstalling = false;
ipcMain.handle('market:install', async (_e, payload) => {
  if (marketInstalling) return { ok: false, error: '已有安装任务进行中，请稍候' };
  const repo = payload && typeof payload.repo === 'string' ? payload.repo : '';
  const mirrorId = payload && typeof payload.mirrorId === 'string' ? payload.mirrorId : '';
  if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/.test(repo)) {
    return { ok: false, error: '仓库地址格式应为 https://github.com/<owner>/<repo>' };
  }
  const mirror = MARKET_MIRRORS.find(m => m.id === mirrorId) ?? MARKET_MIRRORS[0];
  const spec = mirror.prefix + repo.replace(/\/$/, '').replace(/\.git$/, '') + '.git';
  let plan;
  try {
    plan = buildPluginCommand(['add', spec]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  marketInstalling = true;
  const sendLine = (line) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('market-install-progress', { line: String(line || '').slice(0, 200) });
    }
  };
  try {
    sendLine(`> 安装目标: ${spec}`);
    sendLine(`> 镜像: ${mirror.name}`);
    const exitCode = await runPluginCommand(plan, sendLine);
    if (exitCode === 0) {
      sendLine('✓ 安装完成：重启 dsh 后生效');
      return { ok: true, note: '安装完成，需要重启 dsh 生效' };
    }
    sendLine(`✗ 安装失败（退出码 ${exitCode}）：若提示 prepare 脚本被阻止，请在 profile 的 pnpm-workspace.yaml allowBuilds 放行后重试，或交给 AI 安装`);
    return { ok: false, error: `安装失败（退出码 ${exitCode}），详见安装日志` };
  } catch (e) {
    sendLine('✗ 安装异常: ' + (e && e.message ? e.message : String(e)));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    marketInstalling = false;
  }
});

/** 已安装插件列表：读取 $DSH_HOME/profiles/web/package.json 的依赖与 bundle 层。 */
ipcMain.handle('market:installed', () => {
  try {
    const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const file = path.join(home, 'profiles', 'web', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const dependencies = manifest.dependencies && typeof manifest.dependencies === 'object' ? manifest.dependencies : {};
    const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
    // 用户安装的插件 = dependencies 条目（模板 bundle 如 dsh-base 不在 dependencies 里）
    const plugins = Object.keys(dependencies).map(name => ({
      name,
      version: typeof dependencies[name] === 'string' ? dependencies[name] : '',
      inBundles: bundles.includes(name),
    }));
    return { ok: true, file, plugins };
  } catch (e) {
    return { ok: true, plugins: [], file: '' };
  }
});

/** 卸载插件：`dsh plugin --profile web remove <name>`（pnpm 卸载 + bundle 层联动移除）。 */
ipcMain.handle('market:uninstall', async (_e, payload) => {
  if (marketInstalling) return { ok: false, error: '已有插件管理任务进行中，请稍候' };
  const name = payload && typeof payload.name === 'string' ? payload.name.trim() : '';
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name)) {
    return { ok: false, error: '插件名不合法' };
  }
  let plan;
  try {
    plan = buildPluginCommand(['remove', name]);
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
  marketInstalling = true;
  const sendLine = (line) => {
    if (win && !win.isDestroyed()) {
      win.webContents.send('market-install-progress', { line: String(line || '').slice(0, 200) });
    }
  };
  try {
    sendLine(`> 卸载: ${name}`);
    const exitCode = await runPluginCommand(plan, sendLine);
    if (exitCode === 0) {
      sendLine('✓ 卸载完成：重启 dsh 后生效');
      return { ok: true, note: '卸载完成，需要重启 dsh 生效' };
    }
    sendLine(`✗ 卸载失败（退出码 ${exitCode}）`);
    return { ok: false, error: `卸载失败（退出码 ${exitCode}），详见日志` };
  } catch (e) {
    sendLine('✗ 卸载异常: ' + (e && e.message ? e.message : String(e)));
    return { ok: false, error: String((e && e.message) || e) };
  } finally {
    marketInstalling = false;
  }
});

// ---------------- 数据与存储 ----------------

/** 递归目录体积（异常/不存在记 0）。逐目录异步遍历，每 20 个目录让出一次
 *  事件循环——绝不长时间阻塞主进程（旧版 readdirSync recursive + 逐文件
 *  statSync 曾一次锁死 UI 30-60 秒）。结果缓存 5 分钟。 */
const sizeCache = new Map();
async function dirSize(dir) {
  const cached = sizeCache.get(dir);
  if (cached !== undefined && Date.now() - cached.at < 300000) return cached.value;
  let total = 0;
  const stack = [dir];
  let visited = 0;
  try {
    while (stack.length > 0) {
      const cur = stack.pop();
      const entries = await fs.promises.readdir(cur, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(cur, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile()) {
          try {
            total += fs.statSync(full).size;
          } catch (e) {
            /* 单文件权限问题忽略 */
          }
        }
      }
      visited += 1;
      if (visited % 20 === 0) await new Promise(resolve => setImmediate(resolve));
    }
  } catch (e) {
    /* 目录不可读：返回已统计部分 */
  }
  sizeCache.set(dir, { at: Date.now(), value: total });
  return total;
}

/** 已缓存的目录体积（未计算过返回 0，绝不阻塞 data:info）。 */
function dirSizeCached(dir) {
  const cached = sizeCache.get(dir);
  return cached !== undefined && Date.now() - cached.at < 300000 ? cached.value : 0;
}

/** 后台预热体积统计：启动与每次 data:info 后异步补算，界面先显示路径、体积随后就位。 */
function warmDataSizes() {
  const base = clientBaseDir();
  const targets = [path.join(base, 'runtime'), path.join(base, 'funasr'), app.getPath('userData')];
  return Promise.all(targets.map(target => dirSize(target).catch(() => 0)));
}

/** 客户端数据目录一览 + 体积（体积为后台计算的最新缓存值，未就绪时显示 0）。 */
ipcMain.handle('data:info', () => {
  const base = clientBaseDir();
  const runtime = path.join(base, 'runtime');
  const funasr = path.join(base, 'funasr');
  const userData = app.getPath('userData');
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  // 页面打开时若尚无缓存，后台补一次计算（下次打开即显示）
  if (dirSizeCached(runtime) === 0 || dirSizeCached(funasr) === 0 || dirSizeCached(userData) === 0) {
    void warmDataSizes();
  }
  const runtimeSize = dirSizeCached(runtime);
  const funasrSize = dirSizeCached(funasr);
  const userDataSize = dirSizeCached(userData);
  return {
    base,
    settingsFile: clientSettingsFile(),
    runtime,
    funasr,
    userData,
    dshHome,
    sizes: {
      base: runtimeSize + funasrSize + userDataSize,
      runtime: runtimeSize,
      funasr: funasrSize,
      userData: userDataSize,
    },
  };
});

/** 在资源管理器中打开目录。 */
ipcMain.handle('data:open-dir', (_e, dir) => {
  try {
    if (typeof dir === 'string' && dir !== '') shell.openPath(dir);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

/** 清理 Electron 缓存（页面缓存/存储；不动 runtime/funasr/设置/会话）。 */
ipcMain.handle('data:clear-cache', async () => {
  try {
    const { session } = require('electron');
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ['filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage'],
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
});

// 用户个性化（$DSH_HOME/AGENTS.md 结构化内容：偏好块 + 记忆块 + 自由提示词）
ipcMain.handle('instructions:get', () => readAgentsDoc());
ipcMain.handle('instructions:set', (_e, payload) => {
  const p = payload && typeof payload === 'object' ? payload : {};
  // 向后兼容：旧调用传纯字符串视为自由提示词
  if (typeof payload === 'string') {
    const doc = readAgentsDoc();
    writeInstructions(renderAgentsDoc({ ...doc, freePrompt: payload }));
    return { ok: true };
  }
  const preferences = typeof p.preferences === 'string' ? p.preferences : preferencesToText(p.preferences);  const next = {
    freePrompt: typeof p.freePrompt === 'string' ? p.freePrompt : '',
    preferences,
    memory: typeof p.memory === 'string' ? p.memory : '',
    memoryEnabled: p.memoryEnabled === true,
  };
  // 记忆内容持久化到客户端设置（关闭记忆时也不丢失，重新开启可恢复）
  writeClientSettings({ prefs: { preferences, memory: next.memory, memoryEnabled: next.memoryEnabled } });
  writeInstructions(renderAgentsDoc(next));
  return { ok: true };
});

// 任务完成系统通知：dsh 前端在会话 running 结束（true→false）时通知主进程
ipcMain.on('task-complete', () => {
  try {
    if (readClientSettings().notifyOnComplete !== true) return;
    const { Notification } = require('electron');
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: 'DeepSeek Harness',
      body: '任务已完成',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      silent: false,
    });
    n.show();
  } catch (e) {
    console.error('[notify] 任务完成通知失败:', e.message);
  }
});

// 会话统计：用系统 Node（>=22.15 内置 node:zlib zstd）扫描 $DSH_HOME/sessions 聚合。
// 性能设计：
//  1. 脚本内部增量缓存（stats-cache.json，未变化文件跳过解码），稳定后单次扫描亚秒级；
//  2. 快照秒开（stats-snapshot.json）：有快照立即返回旧数据，后台刷新完成后推送 stats-updated；
//  3. 全异步 execFile，主进程永不阻塞。
let statsCache = { at: 0, data: null };
let statsScanning = false;

function statsSnapshotFile() {
  const base = clientBaseDir();
  return path.join(base, 'stats-snapshot.json');
}

function readStatsSnapshot() {
  try {
    const data = JSON.parse(fs.readFileSync(statsSnapshotFile(), 'utf8'));
    return data && data.available === true ? data : null;
  } catch (e) {
    return null;
  }
}

async function runStatsScan() {
  const { detectNode } = require('./bootstrap');
  const nodeExe = detectNode();
  if (!nodeExe) return { available: false, reason: 'no-node' };
  const { execFile } = require('child_process');
  // asar 归档内路径无法被外部 node 直接执行：读出脚本内容经 stdin 传入 node
  const script = fs.readFileSync(path.join(__dirname, 'stats-script.js'), 'utf8');
  const out = await new Promise((resolve, reject) => {
    execFile(nodeExe, ['-'], {
      input: script,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
  return JSON.parse(out);
}

ipcMain.handle('stats:get', async () => {
  try {
    if (statsCache.data !== null && Date.now() - statsCache.at < 60000) {
      return statsCache.data;
    }
    // 有历史快照：立即返回（界面秒开），后台补一次增量刷新，完成后推送给前端
    const snapshot = readStatsSnapshot();
    if (snapshot !== null) {
      statsCache = { at: Date.now(), data: snapshot };
      if (!statsScanning) {
        statsScanning = true;
        runStatsScan()
          .then(data => {
            if (data && data.available === true) {
              statsCache = { at: Date.now(), data };
              if (win && !win.isDestroyed()) {
                win.webContents.send('stats-updated', data);
              }
            }
          })
          .catch(() => { /* 后台刷新失败保持快照数据 */ })
          .finally(() => { statsScanning = false; });
      }
      return snapshot;
    }
    // 首次无快照：等待完整扫描
    const data = await runStatsScan();
    statsCache = { at: Date.now(), data };
    return data;
  } catch (e) {
    return { available: false, reason: String(e) };
  }
});

// ---------------- 语音输入（ASR） ----------------

const DEFAULT_ASR = {
  mode: 'remote', // 'remote'（小米 MiMo ASR）| 'local'（FunASR 本地服务）
  remoteBaseUrl: 'https://api.xiaomimimo.com/v1',
  apiKey: '',
  model: 'mimo-v2.5-asr',
  language: 'zh', // auto | zh | en
  localUrl: 'http://127.0.0.1:10095',
};

function readAsrConfig() {
  return { ...DEFAULT_ASR, ...(readClientSettings().asr || {}) };
}

ipcMain.handle('asr:config:get', async () => {
  const cfg = readAsrConfig();
  // 附带本地服务状态，便于前端判断"是否已配置可用"
  let local = { deployed: false, running: false };
  try {
    const funasr = require('./funasr-deploy');
    local = await funasr.status();
  } catch (e) {
    /* ignore */
  }
  return { ...cfg, localDeployed: local.deployed, localRunning: local.running };
});
ipcMain.handle('asr:config:set', (_e, patch) => {
  const cfg = { ...readAsrConfig(), ...(patch && typeof patch === 'object' ? patch : {}) };
  writeClientSettings({ asr: cfg });
  return cfg;
});

// FunASR 本地服务：状态 / 一键部署 / 启动 / 停止
ipcMain.handle('asr:local:status', async () => {
  try {
    return await require('./funasr-deploy').status();
  } catch (e) {
    return { deployed: false, running: false, error: String(e) };
  }
});
ipcMain.handle('asr:local:deploy', async () => {
  try {
    return await require('./funasr-deploy').deploy({
      onProgress: ev => {
        if (win && !win.isDestroyed()) win.webContents.send('asr-deploy-progress', ev);
      },
    });
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('asr:local:start', async () => {
  try {
    return await require('./funasr-deploy').start();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle('asr:local:stop', async () => {
  try {
    return await require('./funasr-deploy').stop();
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});

// 语音转写：wavBase64（PCM16 16kHz WAV）→ 文本
ipcMain.handle('asr:transcribe', async (_e, wavBase64) => {
  const cfg = readAsrConfig();
  try {
    if (typeof wavBase64 !== 'string' || wavBase64.length === 0) {
      return { ok: false, error: 'empty audio' };
    }
    if (cfg.mode === 'local') {
      // 内置 FunASR 服务：POST {localUrl}/asr，body 为原始 WAV 字节
      const buf = Buffer.from(wavBase64, 'base64');
      const res = await fetch(cfg.localUrl.replace(/\/+$/, '') + '/asr', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: buf,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return { ok: false, error: (data && data.error) || 'funasr HTTP ' + res.status };
      return { ok: true, text: (data && data.text) || '' };
    }
    // 小米 MiMo ASR（OpenAI 兼容 chat/completions）
    const res = await fetch(cfg.remoteBaseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': cfg.apiKey || '',
      },
      body: JSON.stringify({
        model: cfg.model || 'mimo-v2.5-asr',
        messages: [
          {
            role: 'user',
            content: [{ type: 'input_audio', input_audio: { data: `data:audio/wav;base64,${wavBase64}`, format: 'wav' } }],
          },
        ],
        asr_options: { language: cfg.language || 'auto' },
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, error: (data && (data.error || data.message)) || 'HTTP ' + res.status };
    }
    const text = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    return { ok: true, text };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
});

// 设置页 iframe 内嵌 dsh 页面：加载完成后自动打开原设置面板（移植全部网页设置功能）
let pendingVoiceSection = false;
ipcMain.handle('open-voice-settings', () => {
  // 语音引导：直接回到 dsh 页面，并自动打开设置面板的"语音输入"tab
  pendingVoiceSection = true;
  if (win && !win.isDestroyed()) {
    const url = bootResult ? bootResult.url : APP_URL;
    if (win.webContents.getURL() !== url) loadDshPage(12);
    else autoOpenSettingsPanel(win.webContents.mainFrame).then(() => {});
  }
});
ipcMain.handle('voice-pending:get', () => {
  const value = pendingVoiceSection;
  pendingVoiceSection = false;
  return value;
});
function autoOpenSettingsPanel(frame) {
  const openVoice = pendingVoiceSection;
  pendingVoiceSection = false;
  const voiceClick = openVoice
    ? `await sleep(700); const voice = [...document.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '语音输入'); if (voice) voice.click();`
    : '';
  return frame
    .executeJavaScript(
      `(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const alreadyOpen = () => document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
        const findSettings = () => [...document.querySelectorAll('button')].find((x) =>
          (x.textContent || '').trim() === '设置' || (x.getAttribute('aria-label') || '').includes('设置')
        );
        for (let i = 0; i < 30; i++) {
          if (alreadyOpen()) { ${voiceClick} return 'clicked'; }
          const btn = findSettings();
          if (btn) { btn.click(); ${voiceClick} return 'clicked'; }
          const open = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').includes('打开侧边栏'));
          if (open) open.click();
          await sleep(800);
        }
        return 'not-found';
      })()`
    )
    .catch((e) => 'err: ' + e.message);
}

ipcMain.on('open-in-browser', async () => {
  if (!bootResult) {
    await showStartupFailure(lastBootError || '本地服务尚未启动，请先点击重试。');
    return;
  }
  const url = bootResult ? bootResult.url : APP_URL;
  if (bootResult?.browserUrl) {
    await shell.openExternal(bootResult.browserUrl);
  } else if (await require('./bootstrap').probeStatus() === 200) {
    await shell.openExternal(url);
  } else {
    await require('electron').dialog.showMessageBox(win, {
      type: 'info',
      message: '请使用原服务启动窗口中显示的浏览器链接',
      detail: '当前服务由其他程序启动，浏览器需要单独授权。你仍然可以在客户端中继续使用。',
      buttons: ['知道了'],
    });
  }
});

async function startBackgroundClient() {
  createTray();
  autoLog('自启模式启动');
  const success = await runBootstrap();
  if (success) {
    autoLog('dsh 已就绪，客户端保持后台运行');
    if (!tray && !userOpened) showWindow();
    return true;
  }
  autoLog('后台服务启动失败，打开启动页供重试');
  userOpened = true;
  if (settingsRequested) {
    showWindow(true);
    return false;
  }
  if (!win || win.isDestroyed()) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  await showStartupFailure(lastBootError);
  return false;
}

// 生命周期
app.whenReady().then(() => {
  ensureAutoStart();
  migrateAgentsDoc(); // 旧版 AGENTS.md 格式自动迁移（指引文本误含块标记的历史版本）

  // 语音输入：仅对本地页面（客户端自己的启动页/设置页与 dsh 内嵌页）放行麦克风权限
  try {
    const { session } = require('electron');
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      let url = '';
      try {
        url = webContents.getURL();
      } catch (e) {
        /* ignore */
      }
      const local = url.startsWith('file:') || url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:');
      const audioPermission = permission === 'media' || permission === 'microphone' || permission === 'audioCapture';
      callback(local && audioPermission);
    });
  } catch (e) {
    console.error('[voice] 权限处理器设置失败:', e.message);
  }

  if (AUTO_START && !settingsRequested) {
    void startBackgroundClient().catch((error) => {
      autoLog('无法启动后台客户端: ' + (error.message || error));
      app.exit(1);
    });
    return;
  }

  createWindow();
  createTray();
  runBootstrap();
  void warmDataSizes(); // 后台预热数据目录体积统计（不阻塞启动）

  // 启动时静默检查更新（失败静默，不打扰用户）
  if (readClientSettings().autoUpdateCheck) {
    checkUpdate().then((r) => {
      if (r.hasUpdate) console.log(`[update] 发现新版本 ${r.latest}（当前 ${r.current}）: ${r.url}`);
    }).catch(() => {});
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // 有托盘时窗口关闭不等于退出：仅当非"关闭到托盘"配置时退出
  app.quit();
});

let stoppingOnQuit = null;
app.on('before-quit', (event) => {
  quitting = true;
  // 只有本客户端启动的服务且用户开启"关闭时停止"时才停止；用户原本就在运行的服务保持不动
  if (bootResult && bootResult.stop && !bootResult.alreadyRunning) {
    if (readClientSettings().stopDshOnQuit) {
      event.preventDefault();
      if (stoppingOnQuit === null) {
        stoppingOnQuit = Promise.resolve().then(() => bootResult.stop()).catch(() => {
          console.error('服务退出清理失败');
        }).finally(() => {
          bootResult = null;
          app.quit();
        });
      }
    }
  }
});
