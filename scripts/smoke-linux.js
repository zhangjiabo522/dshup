'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const assert = require('node:assert/strict');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'dshup-smoke-'));
let child;
let port;
const secret = crypto.randomBytes(24).toString('hex');

async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const value = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return value;
}

async function cleanup() {
  if (port) {
    await new Promise((resolve) => {
      const request = http.request({ hostname: '127.0.0.1', port, path: '/shutdown', method: 'POST', headers: { 'X-Smoke-Secret': secret }, timeout: 1000 }, (response) => {
        response.resume();
        response.on('end', resolve);
      });
      request.on('error', resolve);
      request.on('timeout', () => { request.destroy(); resolve(); });
      request.end();
    });
  }
  if (child && child.exitCode === null) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }
  fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

async function main() {
  assert.equal(process.platform, 'linux', '本脚本用于 Linux 安装包');
  assert.notEqual(process.getuid(), 0, '请用普通用户运行，保持 Electron 沙箱启用');
  const executable = process.argv[2] || '/opt/DeepSeek Harness/dshup';
  const node = process.env.DSHUP_SMOKE_NODE || process.execPath;
  const version = spawnSync(node, ['--version'], { encoding: 'utf8' });
  const match = /^v(\d+)\.(\d+)/.exec(version.stdout || '');
  assert.ok(match && (Number(match[1]) > 22 || Number(match[1]) === 22 && Number(match[2]) >= 19), '测试需要 Node.js 22.19 或更新版本，可设置 DSHUP_SMOKE_NODE');
  fs.accessSync(executable, fs.constants.X_OK);
  const home = path.join(temporary, 'home');
  const data = path.join(temporary, 'data');
  const config = path.join(temporary, 'config');
  const runtime = path.join(data, 'DeepSeekHarnessClient', 'runtime');
  const dshHome = path.join(temporary, 'dsh');
  const statePath = path.join(temporary, 'server-state.json');
  for (const dir of [home, data, config, dshHome, path.join(runtime, 'node', 'bin'), path.join(runtime, 'node_modules', '.bin')]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(node, path.join(runtime, 'node', 'bin', 'node'));
  fs.writeFileSync(path.join(runtime, 'node_modules', '.bin', 'dsh'), '#!/usr/bin/env node\n' + fs.readFileSync(path.join(__dirname, 'smoke-dsh-fixture.js'), 'utf8'));
  fs.chmodSync(path.join(runtime, 'node_modules', '.bin', 'dsh'), 0o755);
  fs.writeFileSync(path.join(data, 'DeepSeekHarnessClient', 'client-settings.json'), JSON.stringify({ autoStart: false, autoUpdateCheck: false, mirror: 'official', proxyMode: 'direct', stopOnClose: true }));
  port = await freePort();
  const marker = crypto.randomBytes(20).toString('hex');
  const env = {
    ...process.env,
    HOME: home,
    XDG_DATA_HOME: data,
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(temporary, 'cache'),
    XDG_STATE_HOME: path.join(temporary, 'state'),
    DSH_HOME: dshHome,
    DSH_CHECKOUT: path.join(temporary, 'no-checkout'),
    DSH_PORT: String(port),
    DSHUP_SMOKE_MARKER: marker,
    DSHUP_SMOKE_SECRET: secret,
    DSHUP_SMOKE_STATE: statePath,
  };
  delete env.ELECTRON_RUN_AS_NODE;
  let output = '';
  child = spawn(executable, [...process.argv.slice(3), '--smoke-test'], { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk.toString(); });
  const exit = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`隔离启动超过 90 秒\n${output}`)), 90000);
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  assert.equal(exit.code, 0, `客户端退出失败：${JSON.stringify(exit)}\n${output}`);
  assert.match(output, /\[smoke\] OK/, output);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  assert.equal(state.tokenExchanges, 1, '客户端引导时应仅兑换一次启动令牌');
  assert.ok(state.authenticatedPages >= 2, '引导层和窗口都必须带认证 cookie 加载页面');
  assert.equal(fs.existsSync(path.join(config, 'autostart', 'dshup.desktop')), false, '烟测不得创建自启条目');
  console.log('隔离启动、令牌兑换、认证页面与窗口检查通过，未使用关闭沙箱启动参数。');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
}).finally(cleanup);
