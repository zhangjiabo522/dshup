// renderer/app.js — 引导进度 UI
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const statusText = $('statusText');
  const spinner = $('spinner');
  const barFill = $('barFill');
  const pct = $('pct');
  const logBox = $('log');
  const retryBtn = $('retryBtn');
  const browserBtn = $('browserBtn');

  let lastPct = 0;

  function pushLog(line, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = line;
    logBox.appendChild(div);
    while (logBox.childElementCount > 300) logBox.removeChild(logBox.firstChild);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setProgress(p) {
    lastPct = p;
    barFill.style.width = p + '%';
    pct.textContent = p > 0 ? p + '%' : '';
  }

  function showActions(retry) {
    retryBtn.classList.toggle('hidden', !retry);
    browserBtn.classList.remove('hidden');
  }

  window.dshClient.onEvent((ev) => {
    switch (ev.type) {
      case 'status':
        statusText.textContent = ev.message || '';
        spinner.style.display = 'inline-block';
        break;
      case 'progress':
        if (ev.pct != null) setProgress(ev.pct);
        if (ev.message) statusText.textContent = ev.message;
        break;
      case 'server':
        pushLog('[dsh] ' + (ev.message || ''));
        break;
      case 'log':
        pushLog(ev.message || '');
        break;
      case 'phase':
        statusText.textContent = '正在检查运行状态…';
        break;
      case 'error':
        statusText.textContent = (ev.message || '出错') + '（可重试）';
        pushLog('[错误] ' + (ev.message || ''), 'err');
        break;
      case 'fatal':
        spinner.style.display = 'none';
        statusText.textContent = '启动失败：' + (ev.message || '未知错误');
        pushLog('[致命错误] ' + (ev.message || ''), 'err');
        showActions(true);
        break;
      default:
        if (ev.message) pushLog(ev.message);
    }
  });

  retryBtn.addEventListener('click', () => {
    retryBtn.classList.add('hidden');
    browserBtn.classList.add('hidden');
    setProgress(0);
    statusText.textContent = '正在重试…';
    spinner.style.display = 'inline-block';
    window.dshClient.retry();
  });

  browserBtn.addEventListener('click', () => window.dshClient.openInBrowser());
})();
