'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { pathToFileURL } = require('node:url');

const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');

function loadRecovery(options = {}) {
  const calls = { pages: [], urls: [], events: [], logs: [], exits: [], cookieWrites: [], stopped: 0 };
  const timers = new Map();
  let timerId = 0;
  let context;
  const service = new EventEmitter();
  service.exitCode = null;
  service.signalCode = null;
  const result = { url: 'http://127.0.0.1:39080/', cookies: ['session=fixture'], process: service, alreadyRunning: false, stop: async () => { calls.stopped++; } };
  class FakeWindow extends EventEmitter {
    constructor() {
      super();
      this.url = options.url || 'chrome-error://chromewebdata/';
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        getURL: () => this.url,
        send: (channel, event) => calls.events.push({ channel, ...event }),
        getZoomFactor: () => 1,
        setZoomFactor() {},
        setWindowOpenHandler() {},
        executeJavaScript: async script => options.evaluate ? options.evaluate(script) : true,
      });
    }
    isDestroyed() { return false; }
    loadFile(file) { calls.pages.push(file); this.url = pathToFileURL(file).href; return Promise.resolve(); }
    loadURL(url) {
      calls.urls.push(url);
      this.url = options.loadError ? 'chrome-error://chromewebdata/' : url;
      return options.loadError ? Promise.reject(options.loadError) : Promise.resolve();
    }
  }
  const logStream = new EventEmitter();
  logStream.write = line => calls.logs.push(line);
  context = vm.createContext({
    win: null, booting: false, bootResult: options.bootResult || null,
    lastBootError: '', bootHistory: [], bootLogStream: null,
    pageLoadSerial: 0, fatalRecovery: null, renderRetryTimer: null,
    settingsRequested: !!options.settingsRequested, quitting: false,
    AUTO_START: false, SMOKE: false,
    APP_URL: result.url,
    SPLASH: path.join(__dirname, 'renderer', 'index.html'),
    SETTINGS_PAGE: path.join(__dirname, 'renderer', 'settings.html'),
    BrowserWindow: FakeWindow,
    fs: { mkdirSync() {}, existsSync: () => false, createWriteStream: () => logStream },
    clientBaseDir: () => path.join(__dirname, 'ignored-fake-data'),
    path, process, __dirname, console,
    readClientSettings: () => ({}),
    autoLog: line => calls.logs.push(line),
    shell: { openExternal: async () => {} },
    app: { exit: code => calls.exits.push(code) },
    setTimeout: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimeout: id => timers.delete(id),
    require: name => name === 'electron' ? { session: { defaultSession: { cookies: {
      get: async () => [],
      flushStore: async () => {},
    } } } } : require(name),
    installAuthCookies: async cookies => { calls.cookieWrites.push(cookies); if (options.cookieError) throw options.cookieError; },
    bootstrap: options.bootstrap || (async () => result),
  });
  for (const name of ['send', 'showStartupFailure', 'createWindow', 'runBootstrap', 'loadDshPage']) {
    let start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0, name);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start, name);
    vm.runInContext(source.slice(start, end + 2), context);
  }
  if (options.window !== false) context.win = new FakeWindow();
  const runTimers = async delay => {
    const selected = [...timers.entries()].filter(([, timer]) => timer.delay === delay);
    for (const [id, timer] of selected) { timers.delete(id); await timer.callback(); }
    await settle();
  };
  return { context, calls, service, result, runTimers };
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
}

test('引导失败返回 false、保留根因并清空过期运行结果', async () => {
  const error = new Error('凭据格式不兼容：旧运行时无法读取账号');
  const { context, calls } = loadRecovery({ bootResult: { alreadyRunning: true }, bootstrap: async () => { throw error; } });
  assert.equal(await context.runBootstrap(), false);
  assert.equal(context.bootResult, null);
  assert.equal(context.booting, false);
  assert.equal(context.lastBootError, error.message);
  assert.deepEqual(calls.pages, [context.SPLASH]);
  assert.equal(calls.events.at(-1).type, 'fatal');
  assert.equal(calls.events.at(-1).message, error.message);
  assert.deepEqual(calls.urls, []);
});

test('已启动的服务退出后返回启动页，旧定时导航不能覆盖错误页', async () => {
  const { context, calls, service, runTimers } = loadRecovery();
  assert.equal(await context.runBootstrap(), true);
  service.emit('exit', 17, null);
  await settle();
  assert.equal(context.bootResult, null);
  assert.match(context.lastBootError, /已退出（17）/);
  assert.deepEqual(calls.pages, [context.SPLASH]);
  await runTimers(500);
  assert.deepEqual(calls.urls, []);
});

test('loadURL 拒绝后从 Chromium 错误页恢复启动页并显示连接根因', async () => {
  const { context, calls, result } = loadRecovery({ loadError: new Error('ERR_CONNECTION_REFUSED') });
  context.bootResult = result;
  context.loadDshPage();
  await settle();
  assert.deepEqual(calls.urls, [result.url]);
  assert.equal(context.win.webContents.getURL(), pathToFileURL(context.SPLASH).href);
  assert.match(context.lastBootError, /ERR_CONNECTION_REFUSED/);
  assert.equal(calls.events.at(-1).type, 'fatal');
});

test('打开设置页后，引导完成和服务退出均不覆盖设置', async () => {
  const { context, calls, service, runTimers } = loadRecovery({ settingsRequested: true });
  await context.win.loadFile(context.SETTINGS_PAGE);
  assert.equal(await context.runBootstrap(), true);
  await runTimers(500);
  service.emit('exit', 23, null);
  await settle();
  context.loadDshPage();
  assert.deepEqual(calls.pages, [context.SETTINGS_PAGE]);
  assert.deepEqual(calls.urls, []);
  assert.equal(context.win.webContents.getURL(), pathToFileURL(context.SETTINGS_PAGE).href);
  assert.match(context.lastBootError, /23/);
});

test('启动失败后从设置返回时保留根因并回到启动页，不直接导航服务地址', async () => {
  const error = new Error('凭据格式不兼容：旧运行时无法读取账号');
  const { context, calls } = loadRecovery({ settingsRequested: true, bootstrap: async () => { throw error; } });
  await context.win.loadFile(context.SETTINGS_PAGE);
  assert.equal(await context.runBootstrap(), false);
  let closeSettings;
  context.ipcMain = { handle(name, handler) {
    assert.equal(name, 'close-settings');
    closeSettings = handler;
  } };
  const start = source.indexOf("ipcMain.handle('close-settings',");
  assert.ok(start >= 0);
  const end = source.indexOf('\n});', start);
  assert.ok(end > start);
  vm.runInContext(source.slice(start, end + 4), context);
  closeSettings();
  await settle();
  assert.equal(context.settingsRequested, false);
  assert.deepEqual(calls.urls, []);
  assert.deepEqual(calls.pages, [context.SETTINGS_PAGE, context.SPLASH]);
  assert.equal(context.win.webContents.getURL(), pathToFileURL(context.SPLASH).href);
  assert.equal(context.lastBootError, error.message);
  assert.equal(calls.events.at(-1).type, 'fatal');
  assert.equal(calls.events.at(-1).message, error.message);
});

test('窗口未就绪时的引导日志与错误会在启动页加载后按序重放', async () => {
  const { context, calls } = loadRecovery({ window: false, bootstrap: async ({ onEvent }) => {
    onEvent({ type: 'log', message: '检测到旧版运行时' });
    onEvent({ type: 'status', message: '正在升级私有运行时' });
    throw new Error('依赖下载连接失败');
  } });
  context.send('fatal', { message: '上次启动的错误' });
  assert.equal(await context.runBootstrap(), false);
  assert.deepEqual(calls.events, []);
  context.createWindow();
  context.win.webContents.emit('did-finish-load');
  assert.deepEqual(calls.events.map(event => [event.type, event.message]), [
    ['phase', 'checking'],
    ['log', '检测到旧版运行时'],
    ['status', '正在升级私有运行时'],
    ['fatal', '依赖下载连接失败'],
  ]);
  assert.ok(calls.logs.some(line => line.includes('依赖下载连接失败')));
});

test('设置页完成加载时不重放引导事件', () => {
  const { context, calls } = loadRecovery({ window: false, settingsRequested: true });
  context.send('fatal', { message: '待重试的错误' });
  context.createWindow();
  context.win.webContents.emit('did-finish-load');
  assert.deepEqual(calls.pages, [context.SETTINGS_PAGE]);
  assert.deepEqual(calls.events, []);
});

test('主框架加载失败会恢复启动页，iframe 失败和取消导航不会覆盖主页面', async () => {
  const { context, calls } = loadRecovery({ window: false });
  context.createWindow();
  calls.pages.length = 0;
  await context.win.loadURL(context.APP_URL);
  context.win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', context.APP_URL, false);
  context.win.webContents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', context.APP_URL, true);
  await settle();
  assert.deepEqual(calls.pages, []);
  context.win.webContents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', context.APP_URL, true);
  await settle();
  assert.deepEqual(calls.pages, [context.SPLASH]);
  assert.match(context.lastBootError, /ERR_CONNECTION_REFUSED/);
});

test('保存登录状态失败时停止已启动服务并保留认证错误', async () => {
  const { context, calls } = loadRecovery({ cookieError: new Error('本地登录状态无法保存') });
  assert.equal(await context.runBootstrap(), false);
  assert.equal(calls.stopped, 1);
  assert.equal(context.bootResult, null);
  assert.equal(context.lastBootError, '本地登录状态无法保存');
  assert.deepEqual(calls.pages, [context.SPLASH]);
});

function healthDocument(buttons, text) {
  return { body: { cloneNode() {
    let titlebarPresent = true;
    return {
      get textContent() { return text + (titlebarPresent ? 'DeepSeek Harness 标题栏最小化最大化设置关闭' : ''); },
      querySelectorAll(selector) {
        if (selector === 'button') return Array.from({ length: buttons + (titlebarPresent ? 4 : 0) });
        return [{ remove() { titlebarPresent = false; } }];
      },
    };
  } } };
}

test('仅有标题栏按钮的空白页不能被健康检查误判为成功', async () => {
  const document = healthDocument(0, '');
  const { context, calls, result, runTimers } = loadRecovery({ evaluate: script => vm.runInNewContext(script, { document }) });
  context.bootResult = result;
  context.loadDshPage(0);
  await settle();
  await runTimers(2500);
  assert.deepEqual(calls.pages, [context.SPLASH]);
  assert.match(context.lastBootError, /页面多次加载仍未就绪/);
});

test('四个实际内容按钮及有效正文能通过健康检查', async () => {
  const document = healthDocument(4, '桌面客户端隔离启动检查 认证完成并已加载本地内容');
  const { context, calls, result, runTimers } = loadRecovery({ evaluate: script => vm.runInNewContext(script, { document }) });
  context.bootResult = result;
  context.loadDshPage(0);
  await settle();
  await runTimers(2500);
  assert.deepEqual(calls.pages, []);
  assert.equal(context.lastBootError, '');
  assert.equal(context.win.webContents.getURL(), result.url);
});
