'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadLifecycle(options = {}) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const functions = ['showWindow', 'handleSecondInstance', 'startBackgroundClient'].map(name => {
    let start = source.indexOf(`function ${name}(`);
    assert.ok(start >= 0);
    if (source.slice(start - 6, start) === 'async ') start -= 6;
    const end = source.indexOf('\n}\n', start);
    assert.ok(end > start);
    return source.slice(start, end + 2);
  });
  const calls = { created: 0, tray: 0, shown: 0, focused: 0, pages: [], chats: 0, failures: [], logs: [], timers: [], exits: [] };
  const context = vm.createContext({
    win: null,
    tray: null,
    bootResult: options.bootResult || null,
    userOpened: false,
    settingsRequested: false,
    lastBootError: '服务启动超时，检查依赖版本',
    SETTINGS_PAGE: '/app/renderer/settings.html',
    SPLASH: '/app/renderer/index.html',
    autoLog: text => calls.logs.push(text),
    app: { exit: code => calls.exits.push(code) },
    setTimeout: (callback, delay) => calls.timers.push({ callback, delay }),
    loadDshPage: () => { calls.chats += 1; },
    runBootstrap: options.bootstrap || (async () => true),
    showStartupFailure: async error => { calls.failures.push(error); },
  });
  context.createTray = () => { calls.tray += 1; context.tray = options.noTray ? null : {}; };
  context.createWindow = () => {
    calls.created += 1;
    context.win = {
      isDestroyed: () => false,
      isMinimized: () => false,
      restore: () => {},
      show: () => { calls.shown += 1; },
      focus: () => { calls.focused += 1; },
      loadFile: async page => { calls.pages.push(page); },
    };
  };
  vm.runInContext(functions.join('\n'), context);
  return { context, calls };
}

test('自启成功保持后台与托盘，不安排延时退出', async () => {
  const { context, calls } = loadLifecycle();
  assert.equal(await context.startBackgroundClient(), true);
  assert.equal(calls.tray, 1);
  assert.equal(calls.created, 0);
  assert.deepEqual(calls.exits, []);
  assert.deepEqual(calls.timers, []);
  assert.ok(calls.logs.includes('dsh 已就绪，客户端保持后台运行'));
});

test('自启失败显示原始启动错误而不是宣布就绪', async () => {
  const { context, calls } = loadLifecycle({ bootstrap: async () => false });
  assert.equal(await context.startBackgroundClient(), false);
  assert.equal(calls.created, 1);
  assert.equal(calls.shown, 1);
  assert.deepEqual(calls.failures, [context.lastBootError]);
  assert.equal(calls.logs.some(line => line.includes('已就绪')), false);
  assert.deepEqual(calls.exits, []);
});

test('后台启动期间重复启动会显示窗口且之后不会强退', async () => {
  let complete;
  const boot = new Promise(resolve => { complete = resolve; });
  const { context, calls } = loadLifecycle({ bootstrap: () => boot });
  const pending = context.startBackgroundClient();
  context.handleSecondInstance({}, ['dshup']);
  assert.equal(context.userOpened, true);
  assert.equal(calls.created, 1);
  complete(true);
  assert.equal(await pending, true);
  for (const timer of calls.timers) timer.callback();
  assert.deepEqual(calls.exits, []);
});

test('设置命令打开设置页并阻止旧的聊天导航覆盖', () => {
  const { context, calls } = loadLifecycle({ bootResult: {} });
  context.handleSecondInstance({}, ['dshup']);
  context.handleSecondInstance({}, ['dshup', '--settings']);
  for (const timer of calls.timers) timer.callback();
  assert.equal(context.settingsRequested, true);
  assert.equal(calls.created, 1);
  assert.deepEqual(calls.pages, [context.SETTINGS_PAGE]);
  assert.equal(calls.chats, 0);
});

test('自启失败时保留用户已经打开的设置页', async () => {
  let complete;
  const boot = new Promise(resolve => { complete = resolve; });
  const { context, calls } = loadLifecycle({ bootstrap: () => boot });
  const pending = context.startBackgroundClient();
  context.handleSecondInstance({}, ['dshup', '--settings']);
  complete(false);
  assert.equal(await pending, false);
  assert.equal(calls.pages.at(-1), context.SETTINGS_PAGE);
  assert.deepEqual(calls.failures, []);
});

test('托盘创建失败时显示窗口提供操作入口', async () => {
  const { context, calls } = loadLifecycle({ noTray: true, bootResult: {} });
  assert.equal(await context.startBackgroundClient(), true);
  assert.equal(calls.created, 1);
  assert.equal(calls.shown, 1);
  for (const timer of calls.timers) timer.callback();
  assert.equal(calls.chats, 1);
  assert.deepEqual(calls.exits, []);
});
