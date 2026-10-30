'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');
const {
  RELEASES_URL,
  isTrustedPageUrl,
  linuxAutostartPath,
  createLinuxAutostart,
  linuxAutostartEnabled,
  compareVersions,
  selectReleaseAsset,
  releaseUpdateInfo,
} = require('./desktop-platform');

const asset = name => ({ name, browser_download_url: `https://github.com/zhangjiabo522/dshup/releases/download/v1.2.0/${name}` });

test('桌面桥只信任指定服务来源和应用自己的两个页面', () => {
  const appUrl = 'http://127.0.0.1:3080/';
  const renderer = path.join(__dirname, 'renderer');
  const approved = [appUrl, appUrl + 'session/example?view=settings', ...['index.html', 'settings.html'].map(name => pathToFileURL(path.join(renderer, name)).href)];
  for (const url of approved) assert.equal(isTrustedPageUrl(url, appUrl), true, url);
  for (const url of [
    'http://127.0.0.1:8000/preview',
    'http://localhost:3080/',
    'https://127.0.0.1:3080/',
    'https://example.com/',
    'blob:http://127.0.0.1:3080/example',
    'data:text/html,<h1>preview</h1>',
    pathToFileURL(path.join(os.tmpdir(), 'settings.html')).href,
    pathToFileURL(path.join(renderer, 'preview.html')).href,
    'not a URL',
  ]) assert.equal(isTrustedPageUrl(url, appUrl), false, url);
});

test('非可信页面不会执行预加载桥或安装窗口操作入口', () => {
  const appUrl = 'http://127.0.0.1:3080/';
  const source = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
  const bridgeSource = source.slice(0, source.indexOf('\nlet fitted = false;'));
  const trusted = [appUrl, pathToFileURL(path.join(__dirname, 'renderer', 'settings.html')).href];
  const untrusted = ['http://127.0.0.1:8000/preview', 'https://example.com/', pathToFileURL(path.join(os.tmpdir(), 'settings.html')).href];
  for (const url of [...trusted, ...untrusted]) {
    const exposed = {};
    const context = {
      URL,
      location: { href: url },
      require: name => {
        if (name === './bootstrap') return { APP_URL: appUrl };
        if (name === './desktop-platform') return require('./desktop-platform');
        if (name === 'electron') return {
          contextBridge: { exposeInMainWorld: (name, value) => { exposed[name] = value; } },
          ipcRenderer: {},
        };
        return require(name);
      },
    };
    const approved = trusted.includes(url);
    vm.runInNewContext('(function () {\n' + (approved ? bridgeSource : source) + '\n})()', context);
    assert.equal(Boolean(exposed.dshClient), approved, url);
    if (approved) {
      assert.equal(typeof exposed.dshClient.win.close, 'function');
      assert.equal(typeof exposed.dshClient.market.install, 'function');
    }
  }
});

test('普通导航和重定向应用同一边界并保留外部打开', () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const begin = source.indexOf('  const guardNavigation = (event, url) => {');
  const end = source.indexOf("  win.webContents.on('will-redirect', guardNavigation);", begin) + "  win.webContents.on('will-redirect', guardNavigation);".length;
  assert.ok(begin >= 0 && end > begin);
  const handlers = {};
  const opened = [];
  vm.runInNewContext(source.slice(begin, end), {
    APP_URL: 'http://127.0.0.1:3080/',
    isTrustedPageUrl,
    win: { webContents: { on: (name, callback) => { handlers[name] = callback; } } },
    shell: { openExternal: url => { opened.push(url); return Promise.resolve(); } },
  });
  assert.equal(handlers['will-navigate'], handlers['will-redirect']);
  for (const handler of Object.values(handlers)) {
    let prevented = false;
    handler({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:3080/session');
    assert.equal(prevented, false);
    handler({ preventDefault: () => { prevented = true; } }, 'http://127.0.0.1:8000/preview');
    assert.equal(prevented, true);
  }
  assert.deepEqual(opened, ['http://127.0.0.1:8000/preview', 'http://127.0.0.1:8000/preview']);
});

test('清理页面缓存保留 Harness 登录 cookie', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const begin = source.indexOf("ipcMain.handle('data:clear-cache', async () => {");
  const end = source.indexOf('\n});', begin) + '\n});'.length;
  assert.ok(begin >= 0 && end > begin);
  let handler;
  let options;
  let cacheCleared = false;
  vm.runInNewContext(source.slice(begin, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    require: () => ({ session: { defaultSession: {
      clearCache: async () => { cacheCleared = true; },
      clearStorageData: async value => { options = value; },
    } } }),
  });
  assert.equal((await handler()).ok, true);
  assert.equal(cacheCleared, true);
  assert.ok(Array.isArray(options?.storages));
  assert.equal(options.storages.includes('cookies'), false);
  assert.equal(options.storages.includes('cachestorage'), true);
});

test('Ubuntu 自启目录遵循绝对 XDG 路径并忽略无效相对路径', () => {
  assert.equal(linuxAutostartPath({}, '/home/example'), '/home/example/.config/autostart/dshup.desktop');
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: '/custom config' }, '/home/example'), '/custom config/autostart/dshup.desktop');
  assert.equal(linuxAutostartPath({ XDG_CONFIG_HOME: 'relative' }, '/home/example'), '/home/example/.config/autostart/dshup.desktop');
});

test('Ubuntu 自启状态识别禁用标记且不读取其他分组', () => {
  const enabled = createLinuxAutostart({ executable: '/opt/DeepSeek Harness/dshup', icon: '/tmp/icon.png' });
  assert.equal(linuxAutostartEnabled(enabled), true);
  assert.equal(linuxAutostartEnabled(enabled.replace('Hidden=false', 'Hidden=true')), false);
  assert.equal(linuxAutostartEnabled(enabled.replace('X-GNOME-Autostart-enabled=true', 'X-GNOME-Autostart-enabled=false')), false);
  assert.equal(linuxAutostartEnabled(enabled + '[Other]\nHidden=true\n'), true);
  assert.equal(linuxAutostartEnabled('[Desktop Entry]\nType=Application\n'), false);
  assert.equal(linuxAutostartEnabled('[Other]\nType=Application\nExec=dshup\n'), false);
});

test('启动文件不允许空字符或无效执行程序路径', () => {
  assert.throws(() => createLinuxAutostart({ executable: '/tmp/a=b', icon: '' }));
  assert.throws(() => createLinuxAutostart({ executable: '/tmp/dshup', appPath: 'bad\0path', icon: '' }));
});

test('GLib 实际启动验证空格、引号、反斜杠、百分号和中文路径', { skip: process.platform !== 'linux' }, t => {
  const available = spawnSync('/usr/bin/python3', ['-c', 'from gi.repository import Gio'], { encoding: 'utf8' });
  if (available.status !== 0) return t.skip('本机未安装 Python GLib 绑定');
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dshup-desktop-test-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const program = path.join(temporary, '程序 "引号" $dollar `tick` %f \\slash');
  const script = path.join(temporary, '应用 "引号" $dollar `tick` %u \\slash.js');
  const output = path.join(temporary, 'arguments.json');
  const desktop = path.join(temporary, 'dshup.desktop');
  fs.symlinkSync(process.execPath, program);
  fs.writeFileSync(script, `require('node:fs').writeFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(1)));\n`);
  fs.writeFileSync(desktop, createLinuxAutostart({ executable: program, appPath: script, icon: '/tmp/icon.png' }));
  const validation = spawnSync('desktop-file-validate', [desktop], { encoding: 'utf8' });
  if (!validation.error) assert.equal(validation.status, 0, validation.stderr || validation.stdout);
  const launched = spawnSync('/usr/bin/python3', ['-c', [
    'import os, sys, time',
    'from gi.repository import Gio',
    'entry = Gio.DesktopAppInfo.new_from_filename(sys.argv[1])',
    'assert entry is not None',
    'assert entry.launch([], None)',
    'deadline = time.monotonic() + 5',
    'while not os.path.exists(sys.argv[2]) and time.monotonic() < deadline:',
    '    time.sleep(0.02)',
    'assert os.path.exists(sys.argv[2])',
  ].join('\n'), desktop, output], { encoding: 'utf8', timeout: 8000 });
  assert.equal(launched.status, 0, launched.stderr || launched.error?.message);
  assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')), [script, '--autostart']);
});

test('版本比较正确处理预发布、数字顺序及构建元数据', () => {
  assert.equal(compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.2.0', '1.2.0-rc.10'), 1);
  assert.equal(compareVersions('1.2.0-rc.2', '1.2.0-rc.10'), -1);
  assert.equal(compareVersions('1.2.0-rc.10', '1.2.0'), -1);
  assert.equal(compareVersions('1.2.0+ubuntu.1', '1.2.0+ubuntu.2'), 0);
  assert.equal(compareVersions('invalid', '1.2.0'), 0);
});

test('Ubuntu、Windows、macOS 仅挑选各自系统架构的安装包', () => {
  const names = [
    'dshup-1.2.0-win-x64.exe',
    'dshup-1.2.0-win-arm64.exe',
    'dshup-1.2.0-win-ia32.exe',
    'dshup_1.2.0_amd64.deb',
    'dshup_1.2.0_arm64.deb',
    'dshup-1.2.0-mac-x64.zip',
    'dshup-1.2.0-mac-arm64.zip',
    'dshup-1.2.0-mac-arm64.dmg',
  ];
  const assets = names.map(asset);
  assert.equal(selectReleaseAsset(assets, 'linux', 'x64').name, names[3]);
  assert.equal(selectReleaseAsset(assets, 'linux', 'arm64').name, names[4]);
  assert.equal(selectReleaseAsset(assets, 'win32', 'x64').name, names[0]);
  assert.equal(selectReleaseAsset(assets, 'win32', 'arm64').name, names[1]);
  assert.equal(selectReleaseAsset(assets, 'win32', 'ia32').name, names[2]);
  assert.equal(selectReleaseAsset(assets, 'darwin', 'x64').name, names[5]);
  assert.equal(selectReleaseAsset(assets, 'darwin', 'arm64').name, names[7]);
  assert.equal(selectReleaseAsset([asset('dshup-x86_64.exe')], 'win32', 'ia32'), null);
  assert.equal(selectReleaseAsset([asset('dshup-mac-universal.dmg')], 'darwin', 'arm64').name, 'dshup-mac-universal.dmg');
});

test('缺少匹配资源、架构不明或未知系统时退回发布页', () => {
  const page = 'https://github.com/zhangjiabo522/dshup/releases/tag/v1.2.0';
  const data = { tag_name: 'v1.2.0', html_url: page, assets: [asset('dshup-win-x64.exe'), asset('dshup-setup.exe'), asset('dshup.deb')] };
  for (const [platform, arch] of [['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'arm64'], ['freebsd', 'x64']]) {
    const result = releaseUpdateInfo(data, '1.1.0', platform, arch);
    assert.equal(result.url, page);
    assert.equal(result.assetName, '');
    assert.equal(result.hasUpdate, true);
  }
  assert.equal(releaseUpdateInfo({}, '1.1.0').url, RELEASES_URL);
  assert.equal(releaseUpdateInfo({ html_url: 'javascript:alert(1)' }, '1.1.0').url, RELEASES_URL);
  assert.equal(selectReleaseAsset([{ name: 'dshup-linux-x64.deb', browser_download_url: 'file:///tmp/dshup.deb' }], 'linux', 'x64'), null);
});

test('既有 dshup Windows 安装包命名只兼容 x64', () => {
  const legacy = asset('dshup-Setup-1.2.0.exe');
  assert.equal(selectReleaseAsset([legacy], 'win32', 'x64'), legacy);
  assert.equal(selectReleaseAsset([legacy], 'win32', 'arm64'), null);
  assert.equal(selectReleaseAsset([legacy], 'linux', 'x64'), null);
  assert.equal(selectReleaseAsset([asset('other-Setup-1.2.0.exe')], 'win32', 'x64'), null);
  assert.equal(selectReleaseAsset([asset('dshup-Setup-universal.exe')], 'win32', 'x64'), null);
  const explicit = asset('dshup-1.2.0-win-x64.exe');
  assert.equal(selectReleaseAsset([legacy, explicit], 'win32', 'x64'), explicit);
});
