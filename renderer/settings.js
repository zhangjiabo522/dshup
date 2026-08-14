// renderer/settings.js — 客户端设置页
'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const dsh = window.dshClient;

  // ---- Tab 切换 ----
  const tabs = [...document.querySelectorAll('.tab')];
  const panels = {
    system: $('tab-system'),
    personal: $('tab-personal'),
    web: $('tab-web'),
  };
  tabs.forEach((t) =>
    t.addEventListener('click', () => {
      tabs.forEach((x) => x.classList.toggle('active', x === t));
      for (const [id, panel] of Object.entries(panels)) {
        panel.classList.toggle('active', id === t.dataset.tab);
      }
      // 切到"网页设置"时，自动在 iframe 里打开原 dsh 设置面板
      if (t.dataset.tab === 'web') {
        dsh.autoOpenSettings().catch(() => {});
      }
    })
  );

  // ---- 系统设置 ----
  const autoStartToggle = $('autoStartToggle');
  const stopToggle = $('stopToggle');

  async function loadSystem() {
    try {
      const s = await dsh.settings.get();
      autoStartToggle.checked = !!s.autoStart;
      stopToggle.checked = !!s.stopDshOnQuit;
    } catch (e) {
      /* ignore */
    }
  }
  autoStartToggle.addEventListener('change', () => {
    dsh.settings.set('autoStart', autoStartToggle.checked).catch(() => {});
  });
  stopToggle.addEventListener('change', () => {
    dsh.settings.set('stopDshOnQuit', stopToggle.checked).catch(() => {});
  });

  // ---- 个性化提示词 ----
  const instrTextarea = $('instrTextarea');
  const instrPath = $('instrPath');
  const saveBtn = $('saveBtn');
  const saveStatus = $('saveStatus');

  async function loadInstructions() {
    try {
      const r = await dsh.instructions.get();
      instrTextarea.value = r.content || '';
      instrPath.textContent = '保存位置：' + r.file + '（dsh 会在每次对话时自动注入，附加在系统提示词后面）';
    } catch (e) {
      instrPath.textContent = '读取提示词失败：' + (e && e.message ? e.message : e);
    }
  }
  saveBtn.addEventListener('click', async () => {
    try {
      await dsh.instructions.set(instrTextarea.value);
      saveStatus.textContent = '✓ 已保存，下次对话开始生效';
      setTimeout(() => (saveStatus.textContent = ''), 3000);
    } catch (e) {
      saveStatus.textContent = '保存失败';
    }
  });

  // ---- 返回 ----
  $('backBtn').addEventListener('click', () => dsh.closeSettings());

  // ---- 初始化 ----
  loadSystem();
  loadInstructions();
  // 语音引导：主进程要求打开设置并直接落到"网页设置"里的语音输入配置
  dsh.voicePending().then(open => {
    if (open === true) {
      const webTab = tabs.find(t => t.dataset.tab === 'web');
      if (webTab) webTab.click();
    }
  }).catch(() => {});
})();
