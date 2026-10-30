'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

function loadCommands(services) {
  const source = fs.readFileSync(path.join(__dirname, 'main.js'), 'utf8');
  const begin = source.indexOf('function buildPluginCommand(args) {');
  const end = source.indexOf('\nlet marketInstalling = false;', begin);
  assert.ok(begin >= 0 && end > begin);
  const context = vm.createContext({
    process,
    fs,
    os,
    path,
    require: name => name === './bootstrap' ? services : require(name),
  });
  vm.runInContext(source.slice(begin, end), context);
  return { build: context.buildPluginCommand, run: context.runPluginCommand };
}

function fixture(t, missingPnpm) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dshup-plugin-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const shim = path.join(directory, 'dsh 包装器 $ literal');
  const logger = path.join(directory, 'record.js');
  const result = path.join(directory, 'result.json');
  const pnpmDir = path.join(directory, '私有 pnpm');
  const pnpm = path.join(pnpmDir, 'pnpm');
  const installPnpmFile = () => {
    fs.mkdirSync(pnpmDir, { recursive: true });
    fs.writeFileSync(pnpm, '#!/bin/sh\nprintf \'11.7.0\\n\'\n', { mode: 0o755 });
  };
  if (!missingPnpm) installPnpmFile();
  fs.writeFileSync(logger, [
    "const fs = require('node:fs');",
    "const child = require('node:child_process');",
    "const pnpm = child.spawnSync('pnpm', ['--version'], { encoding: 'utf8' });",
    `fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ args: process.argv.slice(2), pnpmStatus: pnpm.status, pnpmVersion: pnpm.stdout.trim() }));`,
    "console.log('插件命令已执行');",
  ].join('\n'));
  fs.writeFileSync(shim, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${logger.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o755 });
  let installs = 0;
  const services = {
    detectCheckout: () => null,
    detectDsh: () => shim,
    detectNode: () => process.execPath,
    detectPnpm: () => fs.existsSync(pnpm) ? pnpm : null,
    installPnpm: async (node, onEvent) => {
      assert.equal(node, process.execPath);
      installs += 1;
      onEvent({ type: 'status', message: '准备私有 pnpm' });
      installPnpmFile();
      return pnpm;
    },
    withRuntimePath: (env, node) => ({ ...env, PATH: [path.dirname(node), '/usr/bin', '/bin'].join(path.delimiter) }),
  };
  return { services, result, installs: () => installs };
}

test('Linux 插件管理直接执行 shell 包装器并原样传递参数', { skip: process.platform !== 'linux' }, async t => {
  const setup = fixture(t, false);
  const command = loadCommands(setup.services);
  const args = ['add', 'file:/tmp/插件 $ literal; "quote"'];
  const plan = command.build(args);
  const progress = [];
  assert.equal(await command.run(plan, line => progress.push(line)), 0);
  const saved = JSON.parse(fs.readFileSync(setup.result, 'utf8'));
  assert.deepEqual(saved.args, ['plugin', '--profile', 'web', ...args]);
  assert.equal(saved.pnpmStatus, 0);
  assert.equal(saved.pnpmVersion, '11.7.0');
  assert.equal(setup.installs(), 0);
  assert.ok(progress.includes('插件命令已执行'));
});

test('缺失 pnpm 时先安装私有依赖再执行插件命令', { skip: process.platform !== 'linux' }, async t => {
  const setup = fixture(t, true);
  const command = loadCommands(setup.services);
  const progress = [];
  const plan = command.build(['remove', '@scope/example']);
  assert.equal(await command.run(plan, line => progress.push(line)), 0);
  assert.equal(setup.installs(), 1);
  const saved = JSON.parse(fs.readFileSync(setup.result, 'utf8'));
  assert.deepEqual(saved.args, ['plugin', '--profile', 'web', 'remove', '@scope/example']);
  assert.equal(saved.pnpmStatus, 0);
  assert.equal(progress[0], '准备私有 pnpm');
  assert.equal(await command.run(plan, () => {}), 0);
  assert.equal(setup.installs(), 1);
});

test('依赖安装失败时不执行插件命令并保留错误原因', { skip: process.platform !== 'linux' }, async t => {
  const setup = fixture(t, true);
  setup.services.installPnpm = async () => { throw new Error('下载失败'); };
  const command = loadCommands(setup.services);
  await assert.rejects(command.run(command.build(['add', 'example']), () => {}), /下载失败/);
  assert.equal(fs.existsSync(setup.result), false);
});
