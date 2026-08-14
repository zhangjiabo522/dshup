// test-bootstrap.js — 无界面测试：验证检测逻辑与"已在运行"分支（不会启动第二个 dsh 实例）
'use strict';

const {
  bootstrap,
  isServerUp,
  detectNode,
  detectPnpm,
  detectCheckout,
  detectDshOnPath,
  runtimeDir,
} = require('./bootstrap');

(async () => {
  console.log('=== 环境检测 ===');
  console.log('node     :', detectNode() || '(未检测到可用 Node)');
  console.log('pnpm     :', detectPnpm() || '(未检测到 pnpm)');
  console.log('checkout :', JSON.stringify(detectCheckout()));
  console.log('dsh PATH :', detectDshOnPath() || '(PATH 无 dsh)');
  console.log('runtime  :', runtimeDir());
  console.log('3080 监听:', await isServerUp());

  console.log('\n=== 引导流程（应命中"已在运行"分支） ===');
  const result = await bootstrap({
    onEvent: (ev) => console.log(`  [${ev.type}] ${ev.message || ''}`),
  });
  console.log('\n=== 结果 ===');
  console.log('url           :', result.url);
  console.log('alreadyRunning:', result.alreadyRunning);
  console.log('process       :', result.process ? `pid=${result.process.pid}` : null);
  process.exit(result.url && result.alreadyRunning === true ? 0 : 1);
})().catch((e) => {
  console.error('测试失败:', e);
  process.exit(1);
});
