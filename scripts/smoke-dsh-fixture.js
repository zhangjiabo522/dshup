'use strict';

const fs = require('node:fs');
const http = require('node:http');
const crypto = require('node:crypto');

if (process.argv.includes('--version')) {
  console.log('0.2.1-rc.5');
  process.exit(0);
}

const port = Number(process.env.DSH_PORT);
const marker = process.env.DSHUP_SMOKE_MARKER;
const statePath = process.env.DSHUP_SMOKE_STATE;
const secret = process.env.DSHUP_SMOKE_SECRET;
if (!port || !marker || !statePath || !secret) throw new Error('缺少隔离测试配置');
const token = crypto.randomBytes(24).toString('hex');
const cookie = `dshup_smoke=${crypto.randomBytes(24).toString('hex')}`;
const state = { tokenExchanges: 0, authenticatedPages: 0, unauthorizedRequests: 0 };
const save = () => fs.writeFileSync(statePath, JSON.stringify(state));
const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/shutdown' && req.method === 'POST' && req.headers['x-smoke-secret'] === secret) {
    res.end('ok');
    server.close(() => process.exit(0));
    return;
  }
  if (url.searchParams.has('token')) {
    if (url.searchParams.get('token') === token && state.tokenExchanges === 0) {
      state.tokenExchanges++;
      save();
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
      res.end();
      return;
    }
    state.unauthorizedRequests++;
    save();
    res.writeHead(401);
    res.end('令牌已消费或无效');
    return;
  }
  if (!(req.headers.cookie || '').split(';').map((value) => value.trim()).includes(cookie)) {
    state.unauthorizedRequests++;
    save();
    res.writeHead(401);
    res.end('需要授权');
    return;
  }
  state.authenticatedPages++;
  save();
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="zh-CN"><head><title>dshup 隔离认证测试</title></head><body><main data-plugin="dshup-client-settings"><h1>桌面客户端隔离启动检查</h1><p data-dshup-smoke>${marker}</p><button aria-label="设置">设置</button><button>模型</button><button>新建会话</button><button>发送</button></main></body></html>`);
});
server.listen(port, '127.0.0.1', () => {
  save();
  console.log(`http://127.0.0.1:${port}/?token=${token}`);
});
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
