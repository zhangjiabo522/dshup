// test-detect.js — 无界面环境检测（不启动 dsh，适合 Linux/macOS/Windows 本地调试）
'use strict';

const {
  isServerUp,
  detectNode,
  detectPnpm,
  detectCheckout,
  detectDshOnPath,
  detectDsh,
  runtimeDir,
  clientBaseDir,
  detectProxy,
} = require('./bootstrap');

(async () => {
  console.log('=== dshup 环境检测 ===');
  console.log('platform :', process.platform, process.arch);
  console.log('node     :', detectNode() || '(未检测到可用 Node，将走私有安装)');
  console.log('pnpm     :', detectPnpm() || '(未检测到 pnpm)');
  console.log('checkout :', JSON.stringify(detectCheckout()));
  console.log('dsh PATH :', detectDshOnPath() || '(PATH 无 dsh)');
  console.log('dsh      :', detectDsh() || '(未检测到 dsh)');
  console.log('base     :', clientBaseDir());
  console.log('runtime  :', runtimeDir());
  console.log('proxy    :', detectProxy() || '(无代理)');
  console.log('3080 监听:', await isServerUp());
  process.exit(0);
})().catch((e) => {
  console.error('检测失败:', e);
  process.exit(1);
});
