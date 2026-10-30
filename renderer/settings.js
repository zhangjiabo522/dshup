// renderer/settings.js — dshup 客户端设置页（不是官方 dsh 网页设置）
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const dsh = window.dshClient;
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = {
    system: $('tab-system'),
    personal: $('tab-personal'),
    web: $('tab-web'),
    data: $('tab-data'),
    market: $('tab-market'),
    stats: $('tab-stats'),
    voice: $('tab-voice'),
    about: $('tab-about'),
  };

  let marketPage = 1;
  let marketQuery = '';
  let marketLoaded = false;
  let dataLoaded = false;
  let statsLoaded = false;
  let aboutLoaded = false;
  let unsubMarket = null;
  let unsubAsr = null;
  let unsubStats = null;

  function setStatus(el, text, kind) {
    if (!el) return;
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function fmtSize(n) {
    const v = Number(n) || 0;
    if (v <= 0) return '计算中 / 0';
    if (v < 1024) return v + ' B';
    if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
    if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
    return (v / 1073741824).toFixed(2) + ' GB';
  }

  function fmtNum(n) {
    return String(Number(n) || 0);
  }

  function fmtMs(ms) {
    const v = Number(ms) || 0;
    if (v < 1000) return v + ' ms';
    if (v < 60000) return (v / 1000).toFixed(1) + ' s';
    return (v / 60000).toFixed(1) + ' min';
  }

  function bindToggle(id, key) {
    const el = $(id);
    el.addEventListener('change', () => {
      dsh.settings.set(key, el.checked).catch(() => {});
    });
  }

  function bindSelect(id, key) {
    const el = $(id);
    el.addEventListener('change', () => {
      dsh.settings.set(key, el.value).catch(() => {});
    });
  }

  async function loadSystem() {
    const s = await dsh.settings.get();
    $('autoStartToggle').checked = !!s.autoStart;
    $('stopToggle').checked = !!s.stopDshOnQuit;
    $('trayToggle').checked = !!s.closeToTray;
    $('minToggle').checked = !!s.launchMinimized;
    $('notifyToggle').checked = !!s.notifyOnComplete;
    $('accelToggle').checked = s.hardwareAcceleration !== false;
    $('updateToggle').checked = s.autoUpdateCheck !== false;
    $('mirrorSelect').value = s.mirror || 'npmmirror';
    $('proxySelect').value = s.proxyMode || 'auto';
  }

  bindToggle('autoStartToggle', 'autoStart');
  bindToggle('stopToggle', 'stopDshOnQuit');
  bindToggle('trayToggle', 'closeToTray');
  bindToggle('minToggle', 'launchMinimized');
  bindToggle('notifyToggle', 'notifyOnComplete');
  bindToggle('accelToggle', 'hardwareAcceleration');
  bindToggle('updateToggle', 'autoUpdateCheck');
  bindSelect('mirrorSelect', 'mirror');
  bindSelect('proxySelect', 'proxyMode');

  async function loadInstructions() {
    try {
      const r = await dsh.instructions.get();
      $('instrTextarea').value = r.freePrompt || r.content || '';
      $('memoryText').value = r.memory || '';
      $('memoryToggle').checked = r.memoryEnabled === true;
      const prefs = r.preferences || {};
      $('langSelect').value = prefs.language || '';
      $('styleSelect').value = prefs.style || '';
      $('instrPath').textContent = '保存位置：' + (r.file || '') + '（dsh 会在每次对话时自动注入，附加在系统提示词后面）';
    } catch (e) {
      $('instrPath').textContent = '读取提示词失败：' + (e && e.message ? e.message : e);
    }
  }

  async function saveInstructions() {
    try {
      await dsh.instructions.set({
        freePrompt: $('instrTextarea').value,
        preferences: {
          language: $('langSelect').value,
          style: $('styleSelect').value,
        },
        memory: $('memoryText').value,
        memoryEnabled: $('memoryToggle').checked,
      });
      setStatus($('saveStatus'), '✓ 已保存，下次对话开始生效');
      setTimeout(() => ($('saveStatus').textContent = ''), 3000);
    } catch (e) {
      setStatus($('saveStatus'), '保存失败', 'err');
    }
  }
  $('saveBtn').addEventListener('click', saveInstructions);
  $('clearMemoryBtn').addEventListener('click', () => {
    $('memoryText').value = '';
    saveInstructions();
  });

  async function loadData() {
    const info = await dsh.data.info();
    const sizes = info.sizes || {};
    $('dataBody').innerHTML = `
      <div class="row"><div><div class="label">客户端数据根目录</div><div class="desc mono">${info.base}</div></div><button class="btn" data-open="${info.base}">打开</button></div>
      <div class="row"><div><div class="label">运行时依赖目录</div><div class="desc mono">${info.runtime}<br>体积 ${fmtSize(sizes.runtime)}</div></div><button class="btn" data-open="${info.runtime}">打开</button></div>
      <div class="row"><div><div class="label">FunASR 目录</div><div class="desc mono">${info.funasr}<br>体积 ${fmtSize(sizes.funasr)}</div></div><button class="btn" data-open="${info.funasr}">打开</button></div>
      <div class="row"><div><div class="label">浏览器缓存目录</div><div class="desc mono">${info.userData}<br>体积 ${fmtSize(sizes.userData)}</div></div><button class="btn" data-open="${info.userData}">打开</button></div>
      <div class="row"><div><div class="label">dsh 用户目录</div><div class="desc mono">${info.dshHome}</div></div><button class="btn" data-open="${info.dshHome}">打开</button></div>
      <div class="row"><div><div class="label">客户端设置文件</div><div class="desc mono">${info.settingsFile}</div></div></div>
      <div class="save-row">
        <button class="btn" id="exportBtn">导出设置</button>
        <button class="btn" id="importBtn">导入设置</button>
        <button class="btn btn-danger" id="clearCacheBtn">清理浏览器缓存</button>
        <span id="dataStatus" class="status"></span>
      </div>
    `;
    $('dataBody').onclick = async (e) => {
      const open = e.target && e.target.getAttribute && e.target.getAttribute('data-open');
      if (open) dsh.data.openDir(open).catch(() => {});
    };
    $('exportBtn').onclick = async () => {
      const r = await dsh.settings.export();
      setStatus($('dataStatus'), r.ok ? '已导出' : (r.canceled ? '已取消' : '导出失败'), r.ok ? '' : 'warn');
    };
    $('importBtn').onclick = async () => {
      const r = await dsh.settings.import();
      if (r.ok) {
        await loadSystem();
        setStatus($('dataStatus'), '已导入');
      } else {
        setStatus($('dataStatus'), r.canceled ? '已取消' : '导入失败', 'warn');
      }
    };
    $('clearCacheBtn').onclick = async () => {
      const r = await dsh.data.clearCache();
      setStatus($('dataStatus'), r.ok ? '缓存已清理' : '清理失败', r.ok ? '' : 'err');
    };
  }

  function appendLog(id, line) {
    const el = $(id);
    el.textContent += (el.textContent ? '\n' : '') + line;
    el.scrollTop = el.scrollHeight;
  }

  async function loadMarket() {
    if (!unsubMarket) {
      unsubMarket = dsh.market.onInstallProgress((p) => {
        if (p && p.line) appendLog('marketLog', p.line);
      });
    }
    $('pluginList').textContent = '插件列表加载中…';
    const r = await dsh.market.list({ query: marketQuery, page: marketPage });
    if (!r.ok) {
      $('pluginList').innerHTML = `<div class="banner">${r.error || '插件列表获取失败'}</div>`;
      $('pageInfo').textContent = '';
      return;
    }
    $('pageInfo').textContent = `第 ${r.page} / ${r.totalPages} 页 · 共 ${r.total} · 来源 ${r.source}`;
    $('pluginList').innerHTML = (r.items || []).map((item) => `
      <div class="plugin" data-repo="${item.cloneUrl || item.htmlUrl}" data-name="${item.fullName}">
        <h3>${item.fullName}</h3>
        <p>${item.description || '暂无简介'}</p>
        <div class="meta">★ ${item.stars || 0} · ${item.language || 'n/a'}</div>
        <div class="acts">
          <button class="btn-primary act-install">一键安装</button>
          <button class="btn act-ai">交给 AI 安装</button>
          <button class="btn act-open">打开仓库</button>
        </div>
      </div>
    `).join('') || '<div class="banner">没有匹配的插件</div>';
  }

  async function loadMine() {
    const r = await dsh.market.installed();
    const plugins = (r && r.plugins) || [];
    $('mineBox').innerHTML = `
      <div class="banner">我的插件（${plugins.length}） ${r.file ? '· ' + r.file : ''}</div>
      ${plugins.map((p) => `
        <div class="plugin" data-name="${p.name}">
          <h3>${p.name}</h3>
          <div class="meta">${p.version || ''} ${p.inBundles ? '· bundle' : ''}</div>
          <div class="acts"><button class="btn btn-danger act-uninstall">卸载</button></div>
        </div>
      `).join('')}
    `;
  }

  $('marketSearchBtn').onclick = () => {
    marketQuery = $('marketQuery').value.trim();
    marketPage = 1;
    loadMarket();
  };
  $('marketQuery').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('marketSearchBtn').click();
  });
  $('prevPage').onclick = () => {
    if (marketPage > 1) {
      marketPage -= 1;
      loadMarket();
    }
  };
  $('nextPage').onclick = () => {
    marketPage += 1;
    loadMarket();
  };
  $('speedtestBtn').onclick = async () => {
    $('speedResult').textContent = '测速中…';
    const r = await dsh.market.speedtest();
    const fastest = r.fastest ? `${r.fastest.name} ${r.fastest.ms}ms` : '无可用镜像';
    $('speedResult').textContent = '最快：' + fastest + '；' + (r.results || []).map((x) => `${x.name}:${x.ok ? x.ms + 'ms' : '失败'}`).join(' / ');
    if (r.fastest) $('marketMirror').value = r.fastest.id;
  };
  $('mineBtn').onclick = loadMine;
  $('pluginList').addEventListener('click', async (e) => {
    const plugin = e.target.closest && e.target.closest('.plugin');
    if (!plugin) return;
    if (e.target.classList.contains('act-install')) {
      const repo = plugin.getAttribute('data-repo');
      appendLog('marketLog', '开始一键安装 ' + repo);
      const r = await dsh.market.install({ repo, mirrorId: $('marketMirror').value });
      appendLog('marketLog', r.ok ? (r.note || '完成') : (r.error || '失败'));
    } else if (e.target.classList.contains('act-ai')) {
      const repo = plugin.getAttribute('data-repo');
      const name = plugin.getAttribute('data-name');
      const prompt = `请帮我安装这个 DeepSeek Harness 插件：\n名称：${name}\n仓库：${repo}\n请使用 dsh plugin --profile web add 安装到 web profile。`;
      try {
        await navigator.clipboard.writeText(prompt);
        appendLog('marketLog', '已复制「交给 AI 安装」提示词，返回对话窗口即可粘贴');
      } catch (err) {
        appendLog('marketLog', prompt);
      }
    } else if (e.target.classList.contains('act-open')) {
      dsh.openExternal(plugin.getAttribute('data-repo')).catch(() => {});
    }
  });
  $('mineBox').addEventListener('click', async (e) => {
    const plugin = e.target.closest && e.target.closest('.plugin');
    if (!plugin || !e.target.classList.contains('act-uninstall')) return;
    const name = plugin.getAttribute('data-name');
    appendLog('marketLog', '开始卸载 ' + name);
    const r = await dsh.market.uninstall({ name });
    appendLog('marketLog', r.ok ? (r.note || '完成') : (r.error || '失败'));
    loadMine();
  });

  function renderStats(data) {
    if (!data || data.available !== true) {
      $('statsBody').innerHTML = `<div class="banner">暂无统计：${(data && data.reason) || '还没有本地会话'}</div>`;
      return;
    }
    const daily = data.daily || {};
    const days = [];
    const now = new Date();
    for (let i = 13; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      days.push({ key, v: daily[key] || 0 });
    }
    const max = Math.max(1, ...days.map((x) => x.v));
    const heat = days.map((x) => {
      const lv = x.v <= 0 ? 0 : x.v / max < 0.25 ? 1 : x.v / max < 0.5 ? 2 : x.v / max < 0.75 ? 3 : 4;
      return `<i class="lv${lv}" title="${x.key}: ${x.v}"></i>`;
    }).join('');

    const calCols = [];
    const start = new Date(now);
    start.setDate(now.getDate() - 89);
    start.setDate(start.getDate() - start.getDay());
    const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    let cursor = new Date(start);
    while (cursor <= now || calCols.length < 13) {
      const col = [];
      for (let r = 0; r < 7; r += 1) {
        const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}-${String(cursor.getDate()).padStart(2, '0')}`;
        const v = daily[key] || 0;
        const lv = v <= 0 ? 0 : v < 1000 ? 1 : v < 5000 ? 2 : v < 20000 ? 3 : 4;
        col.push(`<i class="lv${lv}${key === todayKey ? ' today' : ''}" title="${key}: ${v}"></i>`);
        cursor.setDate(cursor.getDate() + 1);
      }
      calCols.push(`<div class="cal-col">${col.join('')}</div>`);
      if (cursor > now && calCols.length >= 13) break;
      if (calCols.length > 20) break;
    }

    $('statsBody').innerHTML = `
      <div class="cards">
        <div class="card"><div class="k">累计 Token</div><div class="v">${fmtNum(data.totalTokens)}</div></div>
        <div class="card"><div class="k">今日 Token</div><div class="v">${fmtNum(data.todayTokens)}</div></div>
        <div class="card"><div class="k">任务数</div><div class="v">${fmtNum(data.turnCount)}</div></div>
        <div class="card"><div class="k">会话数</div><div class="v">${fmtNum(data.sessionCount)}</div></div>
        <div class="card"><div class="k">最长任务</div><div class="v">${fmtMs(data.longestTaskMs)}</div></div>
      </div>
      <div class="row"><div><div class="label">Token 构成</div><div class="desc">输入 ${fmtNum(data.totalInputTokens)} · 输出 ${fmtNum(data.totalOutputTokens)} · 推理 ${fmtNum(data.totalReasoningTokens)}</div></div></div>
      <div class="label">近 14 天</div>
      <div class="heat">${heat}</div>
      <div class="label" style="margin-top:16px;">近三个月</div>
      <div class="cal">${calCols.join('')}</div>
    `;
  }

  async function loadStats() {
    if (!unsubStats) unsubStats = dsh.stats.onUpdated(renderStats);
    renderStats(await dsh.stats.get());
  }

  async function loadVoice() {
    if (!unsubAsr) {
      unsubAsr = dsh.asr.local.onProgress((ev) => {
        if (ev && ev.message) appendLog('asrLog', ev.message);
        else appendLog('asrLog', JSON.stringify(ev));
      });
    }
    const cfg = await dsh.asr.config.get();
    $('asrMode').value = cfg.mode || 'remote';
    $('asrLang').value = cfg.language || 'zh';
    $('asrBase').value = cfg.remoteBaseUrl || '';
    $('asrModel').value = cfg.model || '';
    $('asrKey').value = cfg.apiKey || '';
    $('asrLocal').value = cfg.localUrl || 'http://127.0.0.1:10095';
    $('asrLocalStatus').textContent = `本地 FunASR：${cfg.localDeployed ? '已部署' : '未部署'} · ${cfg.localRunning ? '运行中' : '未运行'}`;
  }

  $('asrSave').onclick = async () => {
    await dsh.asr.config.set({
      mode: $('asrMode').value,
      language: $('asrLang').value,
      remoteBaseUrl: $('asrBase').value,
      model: $('asrModel').value,
      apiKey: $('asrKey').value,
      localUrl: $('asrLocal').value,
    });
    setStatus($('asrSaveStatus'), '已保存');
  };
  $('asrDeploy').onclick = async () => {
    appendLog('asrLog', '开始一键部署…');
    const r = await dsh.asr.local.deploy();
    appendLog('asrLog', r && r.ok === false ? (r.error || '失败') : '部署结束');
    loadVoice();
  };
  $('asrStart').onclick = async () => {
    const r = await dsh.asr.local.start();
    appendLog('asrLog', r && r.error ? r.error : '已请求启动');
    loadVoice();
  };
  $('asrStop').onclick = async () => {
    const r = await dsh.asr.local.stop();
    appendLog('asrLog', r && r.error ? r.error : '已请求停止');
    loadVoice();
  };

  async function loadAbout() {
    const r = await dsh.update.check();
    $('aboutVer').textContent = `当前版本 ${r.current || '?'}` + (r.latest ? ` · 最新 ${r.latest}` : '');
    if (r.hasUpdate) $('updateStatus').textContent = `发现新版本 ${r.latest}`;
    else if (r.error) $('updateStatus').textContent = '检查更新失败：' + r.error;
    else $('updateStatus').textContent = '已是最新版本，或暂未发布更新';
  }
  $('checkUpdateBtn').onclick = async () => {
    $('updateStatus').textContent = '正在检查更新…';
    await loadAbout();
  };
  $('openRepoBtn').onclick = () => dsh.openExternal('https://github.com/zhangjiabo522/dshup');

  function activate(name) {
    tabs.forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
    for (const [id, panel] of Object.entries(panels)) {
      panel.classList.toggle('active', id === name);
    }
    if (name === 'web') {
      const frame = $('webFrame');
      if (frame.src === 'about:blank') frame.src = dsh.webUrl;
      dsh.autoOpenSettings().catch(() => {});
    }
    if (name === 'data' && !dataLoaded) {
      dataLoaded = true;
      loadData().catch(() => {});
    }
    if (name === 'market' && !marketLoaded) {
      marketLoaded = true;
      loadMarket().catch(() => {});
    }
    if (name === 'stats' && !statsLoaded) {
      statsLoaded = true;
      loadStats().catch(() => {});
    }
    if (name === 'voice') loadVoice().catch(() => {});
    if (name === 'about' && !aboutLoaded) {
      aboutLoaded = true;
      loadAbout().catch(() => {});
    }
  }

  tabs.forEach((t) => t.addEventListener('click', () => activate(t.dataset.tab)));
  $('backBtn').addEventListener('click', () => dsh.closeSettings());

  loadSystem().catch(() => {});
  loadInstructions().catch(() => {});
  dsh.voicePending().then((open) => {
    if (open === true) activate('voice');
  }).catch(() => {});
})();
