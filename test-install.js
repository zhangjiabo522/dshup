// test-install.js — 无界面验证安装链路（npmmirror）：Node → pnpm → dsh，全部装进私有目录，不启动服务器
'use strict';

const fs = require('fs');
const path = require('path');
const {
  installNode,
  installPnpm,
  installDsh,
  runtimeDir,
} = require('./bootstrap');

const rt = runtimeDir();

function log(msg) {
  console.log('[install-test]', msg);
}

(async () => {
  console.log('runtime 目录:', rt);
  fs.mkdirSync(rt, { recursive: true });

  const emit = (ev) => log(`[${ev.type}] ${ev.message || ''}`);

  log('步骤1: 安装 Node.js（国内镜像）…');
  const nodeExe = await installNode(emit);
  log(`node.exe = ${nodeExe}`);
  const ver = require('child_process').spawnSync(nodeExe, ['--version'], { encoding: 'utf8' }).stdout.trim();
  log(`node 版本 = ${ver}`);

  log('步骤2: 安装 pnpm（国内镜像，私有目录）…');
  const pnpm = await installPnpm(nodeExe, emit);
  log(`pnpm.cmd = ${pnpm}`);
  const pv = require('child_process').spawnSync('cmd.exe', ['/d', '/c', `"${pnpm}" --version`], { encoding: 'utf8' }).stdout.trim();
  log(`pnpm 版本 = ${pv}`);

  log('步骤3: 安装 @deepseek-ai/dsh（国内镜像，私有目录）…');
  const dshBin = await installDsh(nodeExe, emit);
  log(`dsh.cmd = ${dshBin}`);
  const dv = require('child_process').spawnSync('cmd.exe', ['/d', '/c', `"${dshBin}" --version`], { encoding: 'utf8' }).stdout.trim();
  log(`dsh 版本 = ${dv}`);

  console.log('\n=== 安装链路验证通过 ===');
})().catch((e) => {
  console.error('安装链路验证失败:', e);
  process.exit(1);
});
