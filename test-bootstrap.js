'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const html = '<!doctype html><script>window.__DSH_BOOT__ = {};</script>';
const fixtureScript = path.join(__dirname, 'test', 'fixtures', 'fake-dsh.cjs');
const envKeys = ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'DSH_HOME', 'DSH_CHECKOUT', 'DSH_PORT', 'PATH', 'DSH_TEST_STATE', 'DSH_TEST_SCENARIO'];

async function listen(server, port = 0) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server.address().port;
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

async function withFixture(scenario, fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dshup-启动验证-'));
  const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const reservation = net.createServer();
  const port = await listen(reservation);
  await close(reservation);
  const home = path.join(root, 'home with $space');
  fs.mkdirSync(home, { recursive: true });
  Object.assign(process.env, {
    HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(root, 'local'),
    XDG_DATA_HOME: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_CACHE_HOME: path.join(root, 'cache'),
    DSH_HOME: path.join(root, 'dsh'), DSH_CHECKOUT: path.join(root, 'absent-checkout'),
    DSH_PORT: String(port), DSH_TEST_STATE: root, DSH_TEST_SCENARIO: scenario, PATH: '',
  });
  delete require.cache[require.resolve('./bootstrap')];
  const api = require('./bootstrap');
  const node = path.join(api.runtimeDir(), 'node', 'bin', 'node');
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.symlinkSync(process.execPath, node);
  const bin = api.privateDshBin();
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  const wrapper = scenario === 'shell'
    ? `#!/bin/sh\nexec node '${fixtureScript.replace(/'/g, "'\\''")}' "$@"\n`
    : `#!/usr/bin/env node\nrequire(${JSON.stringify(fixtureScript)});\n`;
  fs.writeFileSync(bin, wrapper, { mode: 0o755 });
  const results = [];
  const start = async (opts = {}) => {
    const result = await api.bootstrap({ startupTimeoutMs: 2500, authTimeoutMs: 2000, ...opts });
    results.push(result);
    return result;
  };
  try {
    await fn({ api, root, port, start });
  } finally {
    for (const result of results) await result.stop();
    for (const key of envKeys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete require.cache[require.resolve('./bootstrap')];
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function state(root, name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
}

function privatePackage(api, version) {
  const file = path.join(api.runtimeDir(), 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ name: '@deepseek-ai/dsh', version }));
  return file;
}

function fakeNpm(api) {
  const npm = path.join(api.runtimeDir(), 'node', 'bin', 'npm');
  const fixture = path.join(__dirname, 'test', 'fixtures', 'fake-npm.cjs');
  fs.writeFileSync(npm, `#!/usr/bin/env node\nrequire(${JSON.stringify(fixture)});\n`, { mode: 0o755 });
}

async function assertStopped(pid) {
  for (let i = 0; i < 30; i += 1) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === 'ESRCH') return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`测试进程 ${pid} 未退出`);
}

async function externalService(handler, verify) {
  await withFixture('unused', async (fixture) => {
    const server = http.createServer(handler);
    await listen(server, fixture.port);
    try { await verify(fixture); } finally { await close(server); }
  });
}

test('启动与认证在隔离目录和回环网络中验证', { skip: process.platform === 'win32' }, async (t) => {
  await t.test('私有版本按数字预发布顺序判定，未知版本不触发安装', async () => {
    await withFixture('unused', async ({ api }) => {
      assert.equal(api.privateDshVersion(), null);
      assert.equal(api.privateDshNeedsUpgrade(), false);
      for (const [version, expected] of [
        ['0.1.0-rc.6', true], ['0.2.1-alpha.10', true], ['0.2.1-rc.4', true],
        ['0.2.1-rc.5', false], ['0.2.1-rc.5+local.1', false], ['0.2.1-rc.10', false],
        ['0.2.1', false], ['0.2.2-alpha.1', false], ['1.0.0', false], ['custom', false],
      ]) {
        privatePackage(api, version);
        assert.equal(api.privateDshVersion(), version);
        assert.equal(api.privateDshNeedsUpgrade(), expected, version);
      }
    });
  });
  await t.test('旧私有运行时先经私有 npm 升级，再启动服务', async () => {
    await withFixture('upgrade', async ({ api, root, start }) => {
      privatePackage(api, '0.1.0-rc.6');
      fakeNpm(api);
      const events = [];
      const result = await start({ onEvent: (event) => events.push(event.message) });
      assert.equal(result.alreadyRunning, false);
      assert.equal(api.privateDshVersion(), api.MIN_PRIVATE_DSH_VERSION);
      assert.deepEqual(state(root, 'npm-install.json'), {
        prefix: api.runtimeDir(), spec: `@deepseek-ai/dsh@${api.MIN_PRIVATE_DSH_VERSION}`, command: 'install',
      });
      assert.ok(events.some((message) => message.includes(`0.1.0-rc.6 → ${api.MIN_PRIVATE_DSH_VERSION}`)));
      assert.ok(events.indexOf('客户端私有 DeepSeek Harness 已升级') < events.indexOf('启动 DeepSeek Harness Web…'));
    });
  });
  for (const scenario of ['upgrade-fails', 'upgrade-stale']) {
    await t.test(`升级未生效时不启动旧运行时：${scenario}`, async () => {
      await withFixture(scenario, async ({ api, root, start }) => {
        privatePackage(api, '0.1.0-rc.6');
        fakeNpm(api);
        await assert.rejects(start(), /私有运行时升级失败/);
        assert.equal(api.privateDshVersion(), '0.1.0-rc.6');
        assert.equal(fs.existsSync(path.join(root, 'starts.json')), false);
      });
    });
  }
  await t.test('达标与更高的私有版本不重复安装或降级', async () => {
    await withFixture('unused', async ({ api, root }) => {
      fakeNpm(api);
      for (const version of [api.MIN_PRIVATE_DSH_VERSION, '0.2.1-rc.10', '0.2.1', '0.3.0']) {
        privatePackage(api, version);
        const plan = await api.prepareToStart();
        assert.equal(plan.file, api.privateDshBin());
        assert.equal(api.privateDshVersion(), version);
        assert.equal(fs.existsSync(path.join(root, 'npm-install.json')), false);
      }
    });
  });
  await t.test('外部 PATH 运行时不会被私有版本策略升级', async () => {
    await withFixture('unused', async ({ api, root, start }) => {
      fakeNpm(api);
      const external = path.join(root, 'external-bin');
      fs.mkdirSync(external);
      fs.renameSync(api.privateDshBin(), path.join(external, 'dsh'));
      process.env.PATH = external;
      await start();
      assert.equal(api.detectDsh(), path.join(external, 'dsh'));
      assert.equal(fs.existsSync(path.join(root, 'npm-install.json')), false);
    });
  });
  await t.test('已构建源码优先时不会升级旁边的旧私有运行时', async () => {
    await withFixture('unused', async ({ api, root }) => {
      privatePackage(api, '0.1.0-rc.6');
      fakeNpm(api);
      const checkout = path.join(root, 'checkout');
      fs.mkdirSync(path.join(checkout, 'apps', 'web', 'dist'), { recursive: true });
      fs.mkdirSync(path.join(checkout, 'node_modules'));
      fs.writeFileSync(path.join(checkout, 'package.json'), '{}');
      fs.writeFileSync(path.join(checkout, 'apps', 'web', 'dist', 'index.html'), '<!doctype html>');
      process.env.DSH_CHECKOUT = checkout;
      const plan = await api.prepareToStart();
      assert.equal(plan.cwd, checkout);
      assert.ok(plan.args.includes('apps/cli/src/bin.ts'));
      assert.equal(api.privateDshVersion(), '0.1.0-rc.6');
      assert.equal(fs.existsSync(path.join(root, 'npm-install.json')), false);
    });
  });
  await t.test('XDG 数据目录只接受绝对路径', { skip: process.platform !== 'linux' }, async () => {
    await withFixture('unused', async ({ api, root }) => {
      const fallback = path.join(process.env.HOME, '.local', 'share', 'DeepSeekHarnessClient');
      for (const value of ['', 'relative-data', './data', '../data']) {
        process.env.XDG_DATA_HOME = value;
        assert.equal(api.clientBaseDir(), fallback);
      }
      delete process.env.XDG_DATA_HOME;
      assert.equal(api.clientBaseDir(), fallback);
      process.env.XDG_DATA_HOME = path.join(root, 'absolute-data');
      assert.equal(api.clientBaseDir(), path.join(root, 'absolute-data', 'DeepSeekHarnessClient'));
    });
  });
  await t.test('旧版没有令牌仍正常启动，停止不影响其他服务', async () => {
    await withFixture('old', async ({ api, port, root, start }) => {
      const other = http.createServer((req, res) => res.end('其他服务'));
      const otherPort = await listen(other);
      try {
        const result = await start();
        assert.equal(result.url, `http://127.0.0.1:${port}/`);
        assert.equal(result.alreadyRunning, false);
        assert.equal(result.launchUrl, null);
        assert.deepEqual(result.cookies, []);
        assert.equal(state(root, 'starts.json').length, 1);
        assert.ok(fs.existsSync(path.join(process.env.DSH_HOME, 'profiles', 'web', 'cordis.patch.yml')));
        await result.stop();
        await result.stop();
        await assertStopped(result.process.pid);
        assert.equal(await api.isServerUp(port), false);
        assert.equal(await api.isServerUp(otherPort), true);
      } finally { await close(other); }
    });
  });
  await t.test('分块输出令牌只消费一次，日志不泄露令牌', async () => {
    await withFixture('auth', async ({ api, root, start }) => {
      const events = [];
      const result = await start({ onEvent: (event) => events.push(event.message) });
      assert.equal(result.launchUrl, null);
      assert.equal(result.token, null);
      assert.equal(result.browserUrl, `${api.APP_URL}?token=launch_token_1_secret`);
      assert.match(result.cookies[0], /^dsh_session=session_1;/);
      assert.equal(await api.htmlHasDshupPlugin({ cookies: result.cookies }), true);
      assert.deepEqual(state(root, 'token-uses.json'), ['launch_token_1_secret']);
      assert.equal(events.join('\n').includes('launch_token_1_secret'), false);
      assert.ok(events.some((message) => message.includes('[已隐藏]')));
    });
  });
  for (const scenario of ['warming-old', 'warming-auth', 'warming-after-auth']) {
    await t.test(`临时响应会等待真正页面就绪：${scenario}`, async () => {
      await withFixture(scenario, async ({ root, api, start }) => {
        const result = await start();
        assert.equal(await api.htmlHasDshupPlugin({ cookies: result.cookies }), true);
        assert.equal(state(root, 'starts.json').length, 1);
        const expected = scenario === 'warming-after-auth' ? [503, 404, 200] : [404, 503, 200];
        assert.deepEqual(state(root, 'transient-responses.json'), expected);
        if (scenario !== 'warming-old') {
          assert.match(result.cookies[0], /^dsh_session=session_1;/);
          assert.deepEqual(state(root, 'token-uses.json'), ['launch_token_1_secret']);
        }
      });
    });
  }
  for (const scenario of ['never-ready', 'never-ready-after-auth']) {
    await t.test(`持续未就绪时给出页面超时并清理进程：${scenario}`, async () => {
      await withFixture(scenario, async ({ root, start }) => {
        const status = scenario === 'never-ready' ? 503 : 200;
        await assert.rejects(start({ startupTimeoutMs: 700 }), new RegExp(`页面就绪超时.*HTTP ${status}`));
        await assertStopped(state(root, 'starts.json')[0].pid);
        if (scenario === 'never-ready-after-auth') {
          assert.deepEqual(state(root, 'token-uses.json'), ['launch_token_1_secret']);
        }
      });
    });
  }
  await t.test('Cookie 未生效与页面尚未就绪分别报错', async () => {
    await withFixture('invalid-cookie', async ({ root, start }) => {
      await assert.rejects(start({ startupTimeoutMs: 700 }), /浏览器授权未生效（HTTP 401）/);
      await assertStopped(state(root, 'starts.json')[0].pid);
      assert.deepEqual(state(root, 'token-uses.json'), ['launch_token_1_secret']);
    });
  });
  await t.test('插件重启使用新令牌与新 Cookie', async () => {
    await withFixture('restart', async ({ root, start }) => {
      const result = await start();
      const starts = state(root, 'starts.json');
      assert.equal(starts.length, 2);
      await assertStopped(starts[0].pid);
      assert.match(result.cookies[0], /^dsh_session=session_2;/);
      assert.deepEqual(state(root, 'token-uses.json'), ['launch_token_1_secret', 'launch_token_2_secret']);
    });
  });
  await t.test('已有旧版服务可复用且不改写配置', async () => {
    await externalService((req, res) => res.end(html), async ({ api, port, start }) => {
      const result = await start();
      assert.equal(result.alreadyRunning, true);
      assert.equal(result.process, null);
      assert.equal(result.browserUrl, api.APP_URL);
      assert.equal(fs.existsSync(process.env.DSH_HOME), false);
      await result.stop();
      assert.equal(await api.isServerUp(port), true);
    });
  });
  await t.test('已有新版服务拒绝无授权接管，接受有效 Cookie', async () => {
    await externalService((req, res) => {
      if (req.headers.cookie === 'dsh_session=existing') res.end(html);
      else { res.statusCode = 401; res.end('dsh web authentication required'); }
    }, async ({ api, port, start }) => {
      await assert.rejects(start(), /没有有效登录状态/);
      assert.equal(await api.isServerUp(port), true);
      const result = await start({ authCookies: ['dsh_session=existing; Path=/; HttpOnly'] });
      assert.equal(result.alreadyRunning, true);
      assert.equal(fs.existsSync(process.env.DSH_HOME), false);
      await result.stop();
      assert.equal(await api.isServerUp(port), true);
    });
  });
  await t.test('无关 HTTP 服务不会被关闭或当成 dsh 使用', async () => {
    await externalService((req, res) => res.end('其他应用'), async ({ api, port, start }) => {
      await assert.rejects(start(), /被其他服务占用/);
      assert.equal(await api.isServerUp(port), true);
      assert.equal(fs.existsSync(process.env.DSH_HOME), false);
    });
  });
  await t.test('认证失败会清理本次启动的进程', async () => {
    await withFixture('bad-auth', async ({ root, start }) => {
      await assert.rejects(start(), /浏览器授权失败/);
      await assertStopped(state(root, 'starts.json')[0].pid);
    });
  });
  await t.test('新版未输出令牌时明确报错并清理进程', async () => {
    await withFixture('missing-token', async ({ root, start }) => {
      await assert.rejects(start({ authTimeoutMs: 200 }), /未获取到启动令牌/);
      await assertStopped(state(root, 'starts.json')[0].pid);
    });
  });
  await t.test('进程提前退出立即报错而非等待启动超时', async () => {
    await withFixture('exit', async ({ start }) => {
      const started = Date.now();
      await assert.rejects(start({ startupTimeoutMs: 15000 }), /进程已退出（17）/);
      assert.ok(Date.now() - started < 3000);
    });
  });
  await t.test('启动超时会清理自己的进程及子进程', async () => {
    await withFixture('hang', async ({ root, start }) => {
      await assert.rejects(start({ startupTimeoutMs: 600 }), /启动超时/);
      await assertStopped(state(root, 'starts.json')[0].pid);
      await assertStopped(state(root, 'worker.json'));
    });
  });
  await t.test('父进程先退出时仍清理拒绝退出的子进程', async () => {
    await withFixture('stubborn', async ({ root, start }) => {
      await assert.rejects(start({ startupTimeoutMs: 600 }), /启动超时/);
      await assertStopped(state(root, 'starts.json')[0].pid);
      await assertStopped(state(root, 'worker.json'));
    });
  });
  await t.test('桌面空 PATH 下 shell 包装命令仍使用私有 Node', async () => {
    await withFixture('shell', async ({ api, root, start }) => {
      await start();
      const started = state(root, 'starts.json')[0];
      assert.equal(started.execPath, fs.realpathSync(process.execPath));
      assert.ok(started.path.startsWith(path.join(api.runtimeDir(), 'node', 'bin')));
      assert.ok(started.path.split(path.delimiter).includes('/usr/bin'));
      assert.equal(started.port, api.PORT);
    });
  });
});
