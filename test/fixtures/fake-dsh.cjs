'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const root = process.env.DSH_TEST_STATE;
const scenario = process.env.DSH_TEST_SCENARIO;
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]);
if (args[0] !== 'web' || !args.includes('--no-open') || port !== Number(process.env.DSH_PORT)) process.exit(18);
const startsPath = path.join(root, 'starts.json');
const starts = fs.existsSync(startsPath) ? JSON.parse(fs.readFileSync(startsPath, 'utf8')) : [];
starts.push({ pid: process.pid, port, execPath: process.execPath, path: process.env.PATH });
fs.writeFileSync(startsPath, JSON.stringify(starts));
const generation = starts.length;
const token = `launch_token_${generation}_secret`;
const cookie = `dsh_session=session_${generation}`;
let used = false;

if (scenario === 'exit') process.exit(17);
if (scenario === 'hang' || scenario === 'stubborn') {
  const workerCode = scenario === 'stubborn'
    ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
    : 'setInterval(() => {}, 1000)';
  const worker = spawn(process.execPath, ['-e', workerCode], { stdio: 'ignore' });
  fs.writeFileSync(path.join(root, 'worker.json'), JSON.stringify(worker.pid));
  process.on('SIGTERM', () => {
    worker.once('exit', () => process.exit(0));
    setTimeout(() => process.exit(0), 200);
  });
  setInterval(() => {}, 1000);
} else {
  const authRequired = ['auth', 'restart', 'bad-auth', 'missing-token', 'warming-auth', 'warming-after-auth', 'never-ready-after-auth', 'invalid-cookie'].includes(scenario);
  let beforeAuthRequests = 0;
  let afterAuthRequests = 0;
  const transient = (res, status) => {
    const responsesPath = path.join(root, 'transient-responses.json');
    const responses = fs.existsSync(responsesPath) ? JSON.parse(fs.readFileSync(responsesPath, 'utf8')) : [];
    responses.push(status);
    fs.writeFileSync(responsesPath, JSON.stringify(responses));
    res.statusCode = status;
    res.end(status === 404 ? '' : status === 503 ? '服务初始化中' : '<!doctype html><p>正在加载</p>');
  };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.searchParams.has('token')) {
      const usesPath = path.join(root, 'token-uses.json');
      const uses = fs.existsSync(usesPath) ? JSON.parse(fs.readFileSync(usesPath, 'utf8')) : [];
      uses.push(url.searchParams.get('token'));
      fs.writeFileSync(usesPath, JSON.stringify(uses));
      if (used || url.searchParams.get('token') !== token || scenario === 'bad-auth') {
        res.statusCode = 401;
        res.end('令牌无效');
      } else {
        used = true;
        res.writeHead(303, { Location: '/', 'Set-Cookie': `${cookie}; Path=/; HttpOnly; SameSite=Strict` });
        res.end();
      }
      return;
    }
    if (scenario === 'never-ready') return transient(res, 503);
    if (['warming-old', 'warming-auth'].includes(scenario) && beforeAuthRequests < 3) {
      return transient(res, [404, 503, 200][beforeAuthRequests++]);
    }
    if (authRequired && (req.headers.cookie !== cookie || scenario === 'invalid-cookie')) {
      res.statusCode = 401;
      res.end('dsh web authentication required');
      return;
    }
    if (scenario === 'never-ready-after-auth') return transient(res, 200);
    if (scenario === 'warming-after-auth' && afterAuthRequests < 3) {
      return transient(res, [503, 404, 200][afterAuthRequests++]);
    }
    const plugin = scenario === 'restart' && generation === 1 ? '' : 'dshup-client-settings';
    res.end(`<!doctype html><script>window.__DSH_BOOT__ = {};</script>${plugin}`);
  });
  server.listen(port, '127.0.0.1', () => {
    if (!authRequired || scenario === 'missing-token') return;
    setTimeout(() => {
      process.stdout.write(`http://127.0.0.1:${port}/?token=launch_`);
      setTimeout(() => process.stdout.write(`token_${generation}_secret\n`), 75);
    }, generation === 2 ? 450 : 0);
  });
  process.on('SIGTERM', () => server.close(() => process.exit(0)));
}
