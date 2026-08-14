// preload.js — 渲染进程安全桥 + 全页面自定义平滑标题栏
'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');

// ---------- 对外 API ----------
contextBridge.exposeInMainWorld('dshClient', {
  // 主进程引导事件
  onEvent: (cb) => {
    ipcRenderer.on('boot-event', (_event, payload) => cb(payload));
  },
  // 重试引导
  retry: () => ipcRenderer.send('retry-bootstrap'),
  // 打开外部链接
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  // 在系统默认浏览器中打开 dsh
  openInBrowser: () => ipcRenderer.send('open-in-browser'),
  // 自定义标题栏：窗口控制
  win: {
    minimize: () => ipcRenderer.invoke('win-minimize'),
    toggleMaximize: () => ipcRenderer.invoke('win-toggle-maximize'),
    close: () => ipcRenderer.invoke('win-close'),
    isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
    onMaximizedChanged: (cb) => ipcRenderer.on('maximized-changed', (_e, v) => cb(v)),
  },
  // 客户端设置页
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value),
  },
  instructions: {
    get: () => ipcRenderer.invoke('instructions:get'),
    set: (payload) => ipcRenderer.invoke('instructions:set', payload),
  },
  notifyTaskComplete: () => ipcRenderer.send('task-complete'),
  stats: {
    get: () => ipcRenderer.invoke('stats:get'),
  },
  asr: {
    config: {
      get: () => ipcRenderer.invoke('asr:config:get'),
      set: (patch) => ipcRenderer.invoke('asr:config:set', patch),
    },
    transcribe: (wavBase64) => ipcRenderer.invoke('asr:transcribe', wavBase64),
    local: {
      status: () => ipcRenderer.invoke('asr:local:status'),
      deploy: () => ipcRenderer.invoke('asr:local:deploy'),
      start: () => ipcRenderer.invoke('asr:local:start'),
      stop: () => ipcRenderer.invoke('asr:local:stop'),
      onProgress: (cb) => {
        const listener = (_event, payload) => cb(payload);
        ipcRenderer.on('asr-deploy-progress', listener);
        return () => ipcRenderer.removeListener('asr-deploy-progress', listener);
      },
    },
  },
  closeSettings: () => ipcRenderer.invoke('close-settings'),
  autoOpenSettings: () => ipcRenderer.invoke('auto-open-settings-panel'),
  openVoiceSettings: () => ipcRenderer.invoke('open-voice-settings'),
  voicePending: () => ipcRenderer.invoke('voice-pending:get'),
});

// 注入的标题栏代码运行在 isolated world，直接使用 ipcRenderer（不依赖页面主 world 的 dshClient）
let fitted = false; // 是否处于"适应窗口"缩放状态

// dsh 页面根容器（body 下第一个 DIV）
function getRootDiv() {
  try {
    if (!document.body) return null;
    for (const el of document.body.children) {
      if (el.tagName === 'DIV') return el;
    }
    return null;
  } catch (e) {
    return null;
  }
}

// 真实滚动容器（内部滚动，scrollHeight 远大于 clientHeight 的最深容器）
function findDeepestScroller() {
  try {
    const scrollers = [];
    for (const el of document.querySelectorAll('*')) {
      if (el.scrollHeight > el.clientHeight + 300 && el.clientHeight > 0) scrollers.push(el);
    }
    scrollers.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return scrollers[0] || null;
  } catch (e) {
    return null;
  }
}

const winAPI = {
  minimize: () => ipcRenderer.invoke('win-minimize'),
  toggleMaximize: () => ipcRenderer.invoke('win-toggle-maximize'),
  close: () => ipcRenderer.invoke('win-close'),
  isMaximized: () => ipcRenderer.invoke('win-is-maximized'),
  onMaximizedChanged: (cb) => ipcRenderer.on('maximized-changed', (_e, v) => cb(v)),
  // 等比缩小整个页面（CSS transform，保持布局、任意比例），让长页面完整显示在窗口内；再次调用恢复 100%
  fitToWindow: async () => {
    try {
      const root = getRootDiv();
      if (!root) return;
      if (fitted) {
        root.style.transform = '';
        root.style.transformOrigin = '';
        document.body.style.height = '';
        fitted = false;
        return;
      }
      const sc = findDeepestScroller();
      if (!sc) return;
      const rootRect = root.getBoundingClientRect();
      const scRect = sc.getBoundingClientRect();
      const fullH = scRect.top - rootRect.top + sc.scrollHeight;
      const availH = window.innerHeight - TB_HEIGHT;
      const f = Math.max(0.02, Math.min(1, availH / fullH));
      root.style.transformOrigin = 'top left';
      root.style.transform = 'scale(' + f + ')';
      document.body.style.height = TB_HEIGHT + fullH * f + 'px';
      document.body.style.overflow = 'hidden';
      document.documentElement.style.overflow = 'hidden';
      fitted = true;
    } catch (e) {
      /* ignore */
    }
  },
};

// ---------- 自定义平滑标题栏 ----------
// 对启动页（file:）与 dsh 页面（127.0.0.1:3080）统一注入一套标题栏：
// 深色毛玻璃、左侧 Logo + 名称、右侧圆润窗口按钮（悬停平滑过渡、关闭键悬停变红）。

const TITLEBAR_ID = 'dsh-win-titlebar';
const TB_HEIGHT = 36;

function isTargetPage() {
  const h = location.href;
  return (
    h.startsWith('file:') ||
    /^http:\/\/(127\.0\.0\.1|localhost):3080(\/|$)/.test(h)
  );
}

function logoDataUri() {
  try {
    const png = fs.readFileSync(path.join(__dirname, 'assets', 'icon.png'));
    return 'data:image/png;base64,' + png.toString('base64');
  } catch (e) {
    return '';
  }
}

function svg(inner, w, h) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 10 10');
  s.setAttribute('width', String(w || 10));
  s.setAttribute('height', String(h || 10));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.15');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('shape-rendering', 'geometricPrecision');
  s.innerHTML = inner;
  return s;
}

const ICONS = {
  min: svg('<path d="M1 5.2 H9"/>'),
  max: svg('<rect x="1.3" y="1.3" width="7.4" height="7.4" rx="1.8"/>'),
  restore: svg('<rect x="1.4" y="3.2" width="6.6" height="6" rx="1.6"/><path d="M3.2 3.2 V2.1 a1.6 1.6 0 0 1 1.6-1.6 H7.1 a1.6 1.6 0 0 1 1.6 1.6 V5.8 a1.6 1.6 0 0 1-1.6 1.6 H6.2"/>'),
  close: svg('<path d="M2.1 2.1 L7.9 7.9 M7.9 2.1 L2.1 7.9"/>', 11, 11),
  fit: svg('<path d="M1.5 6.4 V8.5 H3.6 M8.5 3.6 V1.5 H6.4 M3.6 1.5 H1.5 V3.6 M6.4 8.5 H8.5 V6.4"/><circle cx="5" cy="5" r="0.9" fill="currentColor" stroke="none"/>'),
};

const TB_CSS = `
#${TITLEBAR_ID} {
  position: fixed;
  top: 0; left: 0; right: 0;
  height: ${TB_HEIGHT}px;
  z-index: 2147483647;
  display: flex;
  align-items: center;
  box-sizing: border-box;
  -webkit-app-region: drag;
  user-select: none;
  cursor: default;
  font-family: "Microsoft YaHei UI", "Segoe UI", system-ui, sans-serif;
  /* 完全透明：与所在页面背景融为一体，无边框无毛玻璃 */
  background: transparent;
  border: none;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}
#${TITLEBAR_ID} .tb-logo {
  width: 17px; height: 17px;
  border-radius: 5px;
  object-fit: cover;
  margin-left: 12px;
  flex: none;
  opacity: 0.85;
}
#${TITLEBAR_ID} .tb-name {
  margin-left: 8px;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 0.3px;
  color: rgba(230, 237, 243, 0.5);
  white-space: nowrap;
}
#${TITLEBAR_ID} .tb-btns {
  margin-left: auto;
  height: 100%;
  display: flex;
  align-items: stretch;
  -webkit-app-region: no-drag;
}
#${TITLEBAR_ID} .tb-btn {
  width: 44px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  margin: 0;
  padding: 0;
  color: rgba(230, 237, 243, 0.38);
  transition: background 0.18s ease, color 0.18s ease;
}
#${TITLEBAR_ID} .tb-btn svg { display: block; }
#${TITLEBAR_ID} .tb-btn:hover {
  background: rgba(255, 255, 255, 0.10);
  color: #ffffff;
}
#${TITLEBAR_ID} .tb-btn:active {
  background: rgba(255, 255, 255, 0.16);
}
#${TITLEBAR_ID} .tb-close:hover {
  background: linear-gradient(180deg, #f0686a, #e03131);
  color: #ffffff;
}
#${TITLEBAR_ID} .tb-close:active {
  background: #c02727;
}
#${TITLEBAR_ID} .tb-ic-restore { display: none; }

/* 页面滚动条美化：细窄、半透明、圆角，悬停变亮 */
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.30);
  background-clip: padding-box;
}
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-corner { background: transparent; }
`;

let tbStyleSheet = null;

function ensureStyle() {
  if (tbStyleSheet) return tbStyleSheet;
  try {
    tbStyleSheet = new CSSStyleSheet();
    tbStyleSheet.replaceSync(TB_CSS);
    document.adoptedStyleSheets = [tbStyleSheet, ...document.adoptedStyleSheets];
  } catch (e) {
    // 回退：普通 <style> 注入
    const st = document.createElement('style');
    st.textContent = TB_CSS;
    document.head.appendChild(st);
    tbStyleSheet = st;
  }
  return tbStyleSheet;
}

function btn(cls, iconEl, title) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tb-btn ' + cls;
  b.title = title;
  b.setAttribute('aria-label', title);
  b.appendChild(iconEl);
  return b;
}

// 捕获阶段统一处理窗口按钮：先于页面任何事件拦截执行，保证按钮始终可用
let captureBound = false;
function bindCaptureHandlers() {
  if (captureBound) return;
  captureBound = true;
  document.addEventListener(
    'click',
    (e) => {
      const target = e.target;
      const b = target && target.closest ? target.closest('#dsh-win-titlebar .tb-btn') : null;
      if (!b) return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      if (b.classList.contains('tb-close')) winAPI.close();
      else if (b.classList.contains('tb-max')) winAPI.toggleMaximize();
      else if (b.classList.contains('tb-min')) winAPI.minimize();
      else if (b.classList.contains('tb-fit')) winAPI.fitToWindow();
    },
    true
  );
  document.addEventListener(
    'dblclick',
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest('#dsh-win-titlebar .tb-btn')) return;
      if (t.closest('#' + TITLEBAR_ID)) {
        e.preventDefault();
        e.stopPropagation();
        winAPI.toggleMaximize();
      }
    },
    true
  );
}

function injectTitlebar() {
  if (!isTargetPage()) return;
  if (document.getElementById(TITLEBAR_ID)) return;
  if (!document.documentElement) return;

  ensureStyle();
  bindCaptureHandlers();

  // 是否为 dsh 内嵌页（http）：只保留右上角按钮，无 logo/文字，视觉完全融入页面
  const isHttpPage = /^http:\/\/(127\.0\.0\.1|localhost):3080(\/|$)/.test(location.href);

  const bar = document.createElement('div');
  bar.id = TITLEBAR_ID;

  if (!isHttpPage) {
    const logo = document.createElement('img');
    logo.className = 'tb-logo';
    logo.alt = '';
    const uri = logoDataUri();
    if (uri) logo.src = uri;

    const name = document.createElement('span');
    name.className = 'tb-name';
    name.textContent = 'DeepSeek Harness';

    bar.appendChild(logo);
    bar.appendChild(name);
  }

  const btns = document.createElement('div');
  btns.className = 'tb-btns';

  const icFit = ICONS.fit.cloneNode(true);
  const icMin = ICONS.min.cloneNode(true);
  const icMax = ICONS.max.cloneNode(true);
  const icRestore = ICONS.restore.cloneNode(true);
  const icClose = ICONS.close.cloneNode(true);

  const fitBtn = btn('tb-fit', icFit, '适应窗口：等比缩小显示整个页面（再次点击恢复，Ctrl+0 复位缩放）');
  const minBtn = btn('tb-min', icMin, '最小化');
  const maxBtn = btn('tb-max', icMax, '最大化');
  const restoreBtn = btn('tb-max tb-ic-restore', icRestore, '还原');
  const closeBtn = btn('tb-close', icClose, '关闭');

  // "适应窗口"按钮仅对内嵌 dsh 页面有意义
  if (isHttpPage) {
    btns.appendChild(fitBtn);
  }
  btns.appendChild(minBtn);
  btns.appendChild(maxBtn);
  btns.appendChild(restoreBtn);
  btns.appendChild(closeBtn);

  bar.appendChild(btns);

  document.documentElement.appendChild(bar);

  // 最大化状态 → 切换 最大化/还原 图标
  const applyMax = (max) => {
    maxBtn.style.display = max ? 'none' : '';
    restoreBtn.style.display = max ? '' : 'none';
  };
  winAPI.isMaximized().then(applyMax).catch(() => {});
  winAPI.onMaximizedChanged(applyMax);
}

// 内嵌页顶部预留标题栏空间：页面内容整体下移，避免拖拽区拦截/遮挡网页顶部按钮。
// 同时压缩 dsh 根容器高度（calc(100vh - 36px)），并永久隐藏 html/body 层滚动
// （消除"窗口最右边两条滚动条"，滚动只发生在页面内部容器）。
function applyReservedSpace() {
  if (!/^http:\/\/(127\.0\.0\.1|localhost):3080(\/|$)/.test(location.href)) return;
  try {
    if (document.body && getComputedStyle(document.body).paddingTop !== TB_HEIGHT + 'px') {
      document.body.style.paddingTop = TB_HEIGHT + 'px';
    }
    if (document.documentElement.style.overflow !== 'hidden') document.documentElement.style.overflow = 'hidden';
    if (document.body && document.body.style.overflow !== 'hidden') document.body.style.overflow = 'hidden';
    const root = getRootDiv();
    if (root) {
      const want = 'calc(100vh - ' + TB_HEIGHT + 'px)';
      if (root.style.height !== want) root.style.height = want;
      if (getComputedStyle(root).overflow !== 'hidden') root.style.overflow = 'hidden';
    }
  } catch (e) {
    /* ignore */
  }
}

function tryInject() {
  try {
    injectTitlebar();
    applyReservedSpace();
  } catch (e) {
    /* 忽略，兜底重试 */
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', tryInject, { once: true });
} else {
  tryInject();
}
window.addEventListener('load', tryInject);
// 兜底：某些 SPA 会重建 DOM，定期检查并补注入
setInterval(tryInject, 2000);
