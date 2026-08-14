// main.js — DeepSeek Harness Windows 客户端（Electron 主进程）
'use strict';

const { app, BrowserWindow, ipcMain, shell } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bootstrap } = require('./bootstrap');

// 显式指定 userData（Chromium 缓存 / GPU 缓存 / localStorage 落点）：
// 安装版默认会按 productName 建目录（含空格），存在首次创建失败风险；
// 统一放到无空格的私有目录，确保始终可写。
app.setPath(
  'userData',
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarnessClient', 'user-data')
);

const SPLASH = path.join(__dirname, 'renderer', 'index.html');
const SETTINGS_PAGE = path.join(__dirname, 'renderer', 'settings.html');

// 客户端本地设置文件
function clientSettingsFile() {
  return path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'DeepSeekHarnessClient',
    'client-settings.json'
  );
}

function autoStartRegExists() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('reg.exe', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', '/v', 'DeepSeek Harness'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return /DeepSeek Harness/.test(out);
  } catch (e) {
    return false;
  }
}

function readClientSettings() {
  // 未保存过时：开机自启默认沿用注册表现状，其余用默认值
  const defaults = { autoStart: autoStartRegExists(), stopDshOnQuit: true };
  try {
    const raw = fs.readFileSync(clientSettingsFile(), 'utf8');
    return { ...defaults, ...JSON.parse(raw) };
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
}

const SMOKE = process.argv.includes('--smoke-test'); // 无人工验证模式：加载成功即退出
const AUTO_START = process.argv.includes('--autostart'); // 开机自启后台模式：拉起 dsh 后自动退出，不弹窗

let win = null;
let bootResult = null; // { url, alreadyRunning, process, stop }
let booting = false;
let userOpened = false; // 自启模式下用户是否主动打开过窗口

// 自启模式日志（便于排查）
function autoLog(line) {
  if (!AUTO_START) return;
  try {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarnessClient');
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
  app.on('second-instance', () => {
    // 自启后台实例收到用户主动打开 → 创建/显示窗口，走正常流程
    userOpened = true;
    if (!win || win.isDestroyed()) {
      createWindow();
    } else {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    if (bootResult && win && !win.isDestroyed()) {
      setTimeout(() => {
        if (win && !win.isDestroyed()) loadDshPage(12);
      }, 300);
    }
  });
}

// 首次正常启动（打包版）时注册开机自启：登录 Windows 自动后台拉起 dsh
// 尊重客户端设置 autoStart（默认关闭）；写入 HKCU Run 键
function ensureAutoStart() {
  try {
    if (!app.isPackaged || AUTO_START || SMOKE) return;
    if (readClientSettings().autoStart) setAutoStartReg(true);
  } catch (e) {
    console.error('[autostart] 注册失败:', e.message);
  }
}

function send(type, payload) {
  if (win && !win.isDestroyed()) {
    win.webContents.send('boot-event', { type, ...(payload || {}) });
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: 'DeepSeek Harness',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    backgroundColor: '#0d1117',
    frame: false, // 无边框：使用自定义平滑标题栏
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(SPLASH);

  // 页面缩放保持用户可控：Ctrl+滚轮 / Ctrl+加号减号 等比缩放（长页面可缩小后完整显示），Ctrl+0 复位
  // 不做任何锁定；每次加载新页面时复位到 100%，避免残留缩放
  win.webContents.on('did-finish-load', () => {
    try {
      if (win.webContents.getZoomFactor() !== 1) win.webContents.setZoomFactor(1);
    } catch (e) {
      /* ignore */
    }
  });

  // 窗口最大化状态变化 → 通知渲染进程切换 最大化/还原 图标
  win.on('maximize', () => send('maximized-changed', true));
  win.on('unmaximize', () => send('maximized-changed', false));

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
              if (systemNav) { systemNav.click(); await sleep(600); systemInfo = { hasNotify: /任务完成时发送系统通知/.test(dialog.textContent || ''), hasAutoStart: /开机自动启动/.test(dialog.textContent || ''), hasStop: /关闭客户端时停止/.test(dialog.textContent || '') }; }
              // 个性化
              const personalNav = [...dialog.querySelectorAll('button')].find((x) => (x.textContent || '').trim() === '个性化');
              let personalInfo = null;
              if (personalNav) { personalNav.click(); await sleep(600); const pt = dialog.textContent || ''; personalInfo = { hasLanguage: /回答语言/.test(pt), hasStyle: /回答风格/.test(pt), hasMemory: /记忆功能/.test(pt), hasClear: /清空记忆/.test(pt), hasSave: /保存全部个性化设置/.test(pt) }; }
              return { dialog: true, systemInfo, personalInfo };
            })()`);
            console.log('[prefs-check] ' + JSON.stringify(result));
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
        const finish = () => {
          console.log('[smoke] OK url=' + url + ' title=' + JSON.stringify(win.webContents.getTitle()));
          setTimeout(() => app.exit(0), 600);
        };
        const verify = async () => {
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
                path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'DeepSeekHarnessClient', 'diag-titlebar.json'),
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
  win.webContents.on('will-navigate', (e, url) => {
    const target = bootResult ? bootResult.url : null;
    if (target && url === target) return; // 允许加载 dsh 页面
    if (url.startsWith('http://') || url.startsWith('https://')) {
      if (!url.startsWith('http://127.0.0.1:') && !url.startsWith('http://localhost:')) {
        e.preventDefault();
        shell.openExternal(url);
      }
    }
  });

  // dsh 服务意外挂掉时，切回启动页并提示重试
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    if (code === -3 /* ERR_ABORTED */) return;
    if (url.startsWith('http://127.0.0.1:') || url.startsWith('http://localhost:')) {
      if (SMOKE) {
        console.error('[smoke] FAILED to load ' + url + ': ' + desc);
        app.exit(1);
      }
      send('fatal', { message: '页面加载失败（' + desc + '），可能 dsh 服务已停止。点击"重试"重新检测并启动。' });
    }
  });

  // 设置页 iframe（内嵌 dsh 页面）：由设置页切到"网页设置"tab 时触发自动打开原设置面板
  win.webContents.on('did-frame-finish-load', (e, isMainFrame) => {
    try {
      const frame = e && e.frame;
      if (isMainFrame) {
        // 语音引导：主窗口回到 dsh 页面后自动打开设置面板并切到"语音输入"
        if (frame && /^https?:\/\/(127\.0\.0\.1|localhost):3080(\/|$)/.test(frame.url) && pendingVoiceSection) {
          setTimeout(() => {
            autoOpenSettingsPanel(frame).then((r) => console.log('[autoopen] main result: ' + r));
          }, 1800);
        }
        return;
      }
      if (frame && /^https?:\/\/(127\.0\.0\.1|localhost):3080(\/|$)/.test(frame.url)) {
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
  if (booting) return;
  booting = true;
  try {
    // 若上次由本客户端启动的服务还活着，先停掉，避免重复实例
    if (bootResult && bootResult.stop && !bootResult.alreadyRunning) {
      try { bootResult.stop(); } catch (e) { /* ignore */ }
    }
    send('phase', { message: 'checking' });
    bootResult = await bootstrap({
      onEvent: (ev) => {
        send(ev.type, ev);
        if (AUTO_START && (ev.type === 'status' || ev.type === 'log' || ev.type === 'error' || ev.type === 'server')) {
          autoLog(ev.message || '');
        }
      },
    });
    // 等待页面首次渲染稳定后再切到内嵌页面
    setTimeout(() => {
      if (win && !win.isDestroyed()) {
        loadDshPage(12);
      }
    }, 500);
  } catch (e) {
    send('fatal', { message: e.message || String(e) });
    if (AUTO_START) autoLog('启动失败: ' + (e.message || e));
    if (SMOKE) {
      console.error('[smoke] BOOTSTRAP FAILED: ' + (e.message || e));
      app.exit(1);
    }
  } finally {
    booting = false;
  }
}

// 加载 dsh 页面 + 渲染健康检查：开机自启刚拉起服务时页面可能尚未渲染（黑屏），
// 自动重新加载直到渲染出界面（最多 retries 次）。
let renderRetryTimer = null;
function loadDshPage(retriesLeft) {
  if (!win || win.isDestroyed()) return;
  const url = bootResult ? bootResult.url : 'http://127.0.0.1:3080/';
  win.loadURL(url).catch(() => { /* ignore */ });
  clearTimeout(renderRetryTimer);
  renderRetryTimer = setTimeout(async () => {
    if (!win || win.isDestroyed()) return;
    if (win.webContents.getURL() !== url) return; // 用户已导航走
    const rendered = await win.webContents
      .executeJavaScript(
        `(() => {
          const buttons = document.querySelectorAll('button').length;
          const textLen = document.body ? (document.body.textContent || '').trim().length : 0;
          return buttons > 3 || textLen > 20;
        })()`
      )
      .catch(() => false);
    if (rendered === true) return;
    if (retriesLeft > 0) {
      send('status', { message: '页面尚未就绪，自动重试中…' });
      loadDshPage(retriesLeft - 1);
    } else {
      send('fatal', { message: '页面多次加载仍未就绪，请重启客户端，或检查 dsh 服务日志。' });
    }
  }, 2500);
}

// IPC
ipcMain.on('retry-bootstrap', () => {
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
  if (win && !win.isDestroyed()) win.loadFile(SETTINGS_PAGE);
});
ipcMain.handle('close-settings', () => {
  if (win && !win.isDestroyed()) {
    const url = bootResult ? bootResult.url : 'http://127.0.0.1:3080/';
    win.loadURL(url);
  }
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
ipcMain.handle('settings:get', () => readClientSettings());
ipcMain.handle('settings:set', (_e, key, value) => {
  const next = writeClientSettings({ [key]: value });
  if (key === 'autoStart') setAutoStartReg(!!value);
  return next;
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

// 会话统计：用系统 Node（>=22.15 内置 node:zlib zstd）扫描 $DSH_HOME/sessions 聚合
let statsCache = { at: 0, data: null };
ipcMain.handle('stats:get', async () => {
  try {
    if (statsCache.data !== null && Date.now() - statsCache.at < 60000) {
      return statsCache.data;
    }
    const { detectNode } = require('./bootstrap');
    const nodeExe = detectNode();
    if (!nodeExe) return { available: false, reason: 'no-node' };
    const { execFileSync } = require('child_process');
    // asar 归档内路径无法被外部 node 直接执行：读出脚本内容经 stdin 传入 node
    const script = fs.readFileSync(path.join(__dirname, 'stats-script.js'), 'utf8');
    const out = execFileSync(nodeExe, ['-'], {
      input: script,
      encoding: 'utf8',
      timeout: 90000,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    const data = JSON.parse(out);
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
    const url = bootResult ? bootResult.url : 'http://127.0.0.1:3080/';
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

ipcMain.on('open-in-browser', () => {
  const url = bootResult ? bootResult.url : 'http://127.0.0.1:3080/';
  shell.openExternal(url);
});

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

  if (AUTO_START) {
    // 开机自启后台模式：不弹窗，拉起 dsh 后自动退出（不停止 dsh）
    autoLog('自启模式启动');
    runBootstrap().then(() => {
      if (!userOpened) {
        autoLog('dsh 已就绪，后台任务退出');
        // 多等 8 秒缓冲：让 dsh 后端完全初始化，用户随后打开时页面直接可用（防黑屏）
        setTimeout(() => app.exit(0), 8000);
      }
    });
    return;
  }

  createWindow();
  runBootstrap();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('before-quit', () => {
  // 只有本客户端启动的服务且用户开启"关闭时停止"时才停止；用户原本就在运行的服务保持不动
  if (bootResult && bootResult.stop && !bootResult.alreadyRunning) {
    if (readClientSettings().stopDshOnQuit) {
      try {
        bootResult.stop();
      } catch (e) {
        /* ignore */
      }
    }
  }
});
