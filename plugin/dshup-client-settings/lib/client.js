window.__ModuleLoader__.load({
	id: "dshup-client-settings",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const jsxRuntime = require("react/jsx-runtime");
		const react = require("react");
		const jsx = jsxRuntime.jsx;
		const jsxs = jsxRuntime.jsxs;
		const { useCallback, useEffect, useMemo, useRef, useState } = react;

		const css = `
.dshupSec{max-width:760px;color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;gap:12px}
.dshupSec h2{margin:0;font-size:16px;font-weight:500;line-height:24px}
.dshupHint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px}
.dshupRow{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l3)}
.dshupRow:last-child{border-bottom:none}
.dshupLabel{font-size:14px;font-weight:500;line-height:22px}
.dshupDesc{margin-top:2px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshupMono{font-family:var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace);font-size:12px;line-height:18px;overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dshupBanner{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);border-radius:8px;padding:10px 12px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dshupBtn,.dshupBtnPri,.dshupBtnDanger{box-sizing:border-box;height:32px;font:inherit;cursor:pointer;border-radius:16px;padding:0 12px;font-size:13px;line-height:20px;display:inline-flex;align-items:center;justify-content:center;gap:6px}
.dshupBtn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary)}
.dshupBtn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshupBtnPri{border:none;background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}
.dshupBtnDanger{border:1px solid var(--dsw-alias-state-error-primary);background:transparent;color:var(--dsw-alias-state-error-primary)}
.dshupBtn:disabled,.dshupBtnPri:disabled{opacity:.45;cursor:default}
.dshupInput,.dshupSelect,.dshupArea{box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;font-size:13px}
.dshupInput,.dshupSelect{height:32px;padding:0 10px;min-width:160px}
.dshupArea{width:100%;padding:8px 10px;min-height:88px;resize:vertical}
.dshupInput:focus,.dshupSelect:focus,.dshupArea:focus{border-color:var(--dsw-alias-brand-primary);outline:none}
.dshupSwitch{position:relative;width:40px;height:22px;flex:none}
.dshupSwitch input{opacity:0;width:0;height:0}
.dshupSlider{position:absolute;inset:0;background:var(--dsw-alias-border-l2);border-radius:11px;cursor:pointer;transition:background .15s}
.dshupSlider:before{content:"";position:absolute;height:16px;width:16px;left:3px;top:3px;background:#fff;border-radius:50%;transition:transform .15s}
.dshupSwitch input:checked + .dshupSlider{background:var(--dsw-alias-state-success-primary)}
.dshupSwitch input:checked + .dshupSlider:before{transform:translateX(18px)}
.dshupActs{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.dshupLog{max-height:180px;overflow:auto;white-space:pre-wrap;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:8px 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary)}
.dshupCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}
.dshupCard{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:10px 12px}
.dshupCard .k{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshupCard .v{font-size:18px;font-weight:600;margin-top:4px}
.dshupHeat{display:flex;gap:3px;flex-wrap:wrap}
.dshupHeat i,.dshupCal i{display:block;width:10px;height:10px;border-radius:2px;background:var(--dsw-alias-border-l3)}
.dshupHeat i.lv1,.dshupCal i.lv1{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 30%, transparent)}
.dshupHeat i.lv2,.dshupCal i.lv2{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 50%, transparent)}
.dshupHeat i.lv3,.dshupCal i.lv3{background:color-mix(in srgb, var(--dsw-alias-state-success-primary) 75%, transparent)}
.dshupHeat i.lv4,.dshupCal i.lv4{background:var(--dsw-alias-state-success-primary)}
.dshupCal{display:flex;gap:3px}
.dshupCalCol{display:flex;flex-direction:column;gap:3px}
.dshupCal i.today{outline:1px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshupPlugin{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px;display:flex;flex-direction:column;gap:6px}
.dshupPlugin h3{margin:0;font-size:14px}
.dshupPlugin p{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dshupMode{display:flex;gap:8px}
.dshupModeBtn{flex:1;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:10px;padding:12px;cursor:pointer;text-align:left;font:inherit}
.dshupModeBtn[data-on="1"]{border-color:var(--dsw-alias-brand-primary);background:color-mix(in srgb, var(--dsw-alias-brand-primary) 10%, transparent)}
.dshupVoiceBtn{box-sizing:border-box;width:32px;height:32px;border:none;background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0}
.dshupVoiceBtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dshupVoiceBtn[data-rec="1"]{color:var(--dsw-alias-state-error-primary)}
.dshupVoiceBtn:disabled{opacity:.4;cursor:default}
`;
		const tagId = "dshup-client-settings/ui.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "dshup-client-settings";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		function api() {
			return typeof window !== "undefined" ? window.dshClient || null : null;
		}

		function fmtSize(n) {
			const v = Number(n) || 0;
			if (v <= 0) return "0";
			if (v < 1024) return v + " B";
			if (v < 1048576) return (v / 1024).toFixed(1) + " KB";
			if (v < 1073741824) return (v / 1048576).toFixed(1) + " MB";
			return (v / 1073741824).toFixed(2) + " GB";
		}
		function fmtNum(n) { return String(Number(n) || 0); }
		function fmtMs(ms) {
			const v = Number(ms) || 0;
			if (v < 1000) return v + " ms";
			if (v < 60000) return (v / 1000).toFixed(1) + " s";
			return (v / 60000).toFixed(1) + " min";
		}

		function Row({ label, desc, children }) {
			return jsxs("div", { className: "dshupRow", children: [
				jsxs("div", { children: [
					jsx("div", { className: "dshupLabel", children: label }),
					desc ? jsx("div", { className: "dshupDesc", children: desc }) : null
				] }),
				children
			] });
		}

		function Toggle({ checked, onChange }) {
			return jsxs("label", { className: "dshupSwitch", children: [
				jsx("input", { type: "checkbox", checked: !!checked, onChange: (e) => onChange(e.target.checked) }),
				jsx("span", { className: "dshupSlider" })
			] });
		}

		function MissingClient() {
			return jsx("div", { className: "dshupBanner", children: "这些是 dshup 桌面客户端功能。请在 dshup 窗口内使用；浏览器直开时没有 window.dshClient。" });
		}

		function SystemSection() {
			const dsh = api();
			const [s, setS] = useState(null);
			const [err, setErr] = useState("");
			const load = useCallback(async () => {
				if (!dsh) return;
				try { setS(await dsh.settings.get()); } catch (e) { setErr(String(e && e.message || e)); }
			}, [dsh]);
			useEffect(() => { load(); }, [load]);
			const set = async (key, value) => {
				if (!dsh) return;
				await dsh.settings.set(key, value);
				setS((prev) => ({ ...(prev || {}), [key]: value }));
			};
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "系统设置" }), jsx(MissingClient, {})] });
			if (!s) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "系统设置" }), jsx("div", { className: "dshupHint", children: err || "加载中…" })] });
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "系统设置" }),
				jsx("p", { className: "dshupHint", children: "这些是 dshup 客户端行为，不是官方 dsh 网页设置" }),
				jsx(Row, { label: "开机自动启动", desc: "登录系统后自动在后台启动", children: jsx(Toggle, { checked: !!s.autoStart, onChange: (v) => set("autoStart", v) }) }),
				jsx(Row, { label: "关闭客户端时停止 dsh 服务", desc: "关闭窗口时停止由本客户端启动的 dsh 后台服务", children: jsx(Toggle, { checked: !!s.stopDshOnQuit, onChange: (v) => set("stopDshOnQuit", v) }) }),
				jsx(Row, { label: "关闭窗口时最小化到托盘", desc: "点关闭按钮时隐藏到系统托盘", children: jsx(Toggle, { checked: !!s.closeToTray, onChange: (v) => set("closeToTray", v) }) }),
				jsx(Row, { label: "启动后最小化", desc: "打开客户端后自动最小化到任务栏", children: jsx(Toggle, { checked: !!s.launchMinimized, onChange: (v) => set("launchMinimized", v) }) }),
				jsx(Row, { label: "任务完成时发送系统通知", desc: "会话任务结束后弹出桌面通知", children: jsx(Toggle, { checked: !!s.notifyOnComplete, onChange: (v) => set("notifyOnComplete", v) }) }),
				jsx(Row, { label: "硬件加速", desc: "GPU 加速渲染。修改后需重启客户端", children: jsx(Toggle, { checked: s.hardwareAcceleration !== false, onChange: (v) => set("hardwareAcceleration", v) }) }),
				jsx(Row, { label: "启动时检查更新", desc: "静默查询 GitHub Releases", children: jsx(Toggle, { checked: s.autoUpdateCheck !== false, onChange: (v) => set("autoUpdateCheck", v) }) }),
				jsx(Row, { label: "下载镜像", desc: "安装 Node / pnpm / dsh 时使用的源", children: jsxs("select", { className: "dshupSelect", value: s.mirror || "npmmirror", onChange: (e) => set("mirror", e.target.value), children: [
					jsx("option", { value: "npmmirror", children: "国内镜像（npmmirror）" }),
					jsx("option", { value: "official", children: "官方源" })
				] }) }),
				jsx(Row, { label: "网络模式", desc: "依赖下载是否走系统代理", children: jsxs("select", { className: "dshupSelect", value: s.proxyMode || "auto", onChange: (e) => set("proxyMode", e.target.value), children: [
					jsx("option", { value: "auto", children: "自动检测系统代理" }),
					jsx("option", { value: "direct", children: "直连，不走代理" })
				] }) })
			] });
		}

		function PersonalSection() {
			const dsh = api();
			const [st, setSt] = useState({ freePrompt: "", memory: "", memoryEnabled: false, language: "", style: "", file: "", status: "" });
			useEffect(() => {
				if (!dsh) return;
				dsh.instructions.get().then((r) => {
					const prefs = r.preferences || {};
					setSt((prev) => ({
						...prev,
						freePrompt: r.freePrompt || r.content || "",
						memory: r.memory || "",
						memoryEnabled: r.memoryEnabled === true,
						language: prefs.language || "",
						style: prefs.style || "",
						file: r.file || "",
					}));
				}).catch((e) => setSt((prev) => ({ ...prev, status: "读取失败：" + (e && e.message || e) })));
			}, [dsh]);
			const save = async (patch) => {
				if (!dsh) return;
				const next = { ...st, ...patch };
				setSt(next);
				try {
					await dsh.instructions.set({
						freePrompt: next.freePrompt,
						preferences: { language: next.language, style: next.style },
						memory: next.memory,
						memoryEnabled: next.memoryEnabled,
					});
					setSt((p) => ({ ...p, status: "✓ 已保存，下次对话开始生效" }));
				} catch (e) {
					setSt((p) => ({ ...p, status: "保存失败" }));
				}
			};
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "个性化" }), jsx(MissingClient, {})] });
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "个性化" }),
				jsx("p", { className: "dshupHint", children: "保存到 $DSH_HOME/AGENTS.md，每次对话自动附加在系统提示词后面" }),
				st.file ? jsx("div", { className: "dshupMono", children: "保存位置：" + st.file }) : null,
				jsx(Row, { label: "回答语言", desc: "写入个性化偏好，模型会尽量遵循", children: jsxs("select", { className: "dshupSelect", value: st.language, onChange: (e) => setSt((p) => ({ ...p, language: e.target.value })), children: [
					jsx("option", { value: "", children: "默认" }),
					jsx("option", { value: "中文", children: "中文" }),
					jsx("option", { value: "English", children: "English" })
				] }) }),
				jsx(Row, { label: "回答风格", desc: "简洁或详细，按你的阅读习惯", children: jsxs("select", { className: "dshupSelect", value: st.style, onChange: (e) => setSt((p) => ({ ...p, style: e.target.value })), children: [
					jsx("option", { value: "", children: "默认" }),
					jsx("option", { value: "简洁", children: "简洁" }),
					jsx("option", { value: "详细", children: "详细" })
				] }) }),
				jsx(Row, { label: "记忆功能", desc: "打开后，客户端会指示模型把重要偏好写入记忆块", children: jsx(Toggle, { checked: st.memoryEnabled, onChange: (v) => setSt((p) => ({ ...p, memoryEnabled: v })) }) }),
				jsx("div", { className: "dshupLabel", children: "记忆内容" }),
				jsx("textarea", { className: "dshupArea", value: st.memory, onChange: (e) => setSt((p) => ({ ...p, memory: e.target.value })), placeholder: "每条一行" }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("button", { type: "button", className: "dshupBtn", onClick: () => save({ memory: "" }), children: "清空记忆" })
				] }),
				jsx("div", { className: "dshupLabel", children: "自定义提示词" }),
				jsx("textarea", { className: "dshupArea", value: st.freePrompt, onChange: (e) => setSt((p) => ({ ...p, freePrompt: e.target.value })) }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("button", { type: "button", className: "dshupBtnPri", onClick: () => save({}), children: "保存全部个性化设置" }),
					jsx("span", { className: "dshupHint", children: st.status })
				] })
			] });
		}

		function DataSection() {
			const dsh = api();
			const [info, setInfo] = useState(null);
			const [status, setStatus] = useState("");
			useEffect(() => {
				if (!dsh) return;
				dsh.data.info().then(setInfo).catch((e) => setStatus(String(e && e.message || e)));
			}, [dsh]);
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "数据与存储" }), jsx(MissingClient, {})] });
			const sizes = (info && info.sizes) || {};
			const row = (label, dir, size) => jsx(Row, { label, desc: jsxs("span", { className: "dshupMono", children: [dir || "", size != null ? jsxs("span", { children: [jsx("br", {}), "体积 ", fmtSize(size)] }) : null] }), children: dir ? jsx("button", { type: "button", className: "dshupBtn", onClick: () => dsh.data.openDir(dir).catch(() => {}), children: "打开" }) : null }, label);
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "数据与存储" }),
				jsx("p", { className: "dshupHint", children: "客户端私有目录，卸载应用不会自动删除" }),
				info ? jsxs("div", { children: [
					row("客户端数据根目录", info.base),
					row("运行时依赖目录", info.runtime, sizes.runtime),
					row("FunASR 目录", info.funasr, sizes.funasr),
					row("浏览器缓存目录", info.userData, sizes.userData),
					row("dsh 用户目录", info.dshHome),
					row("客户端设置文件", info.settingsFile)
				] }) : jsx("div", { className: "dshupBanner", children: status || "正在读取目录信息…" }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("button", { type: "button", className: "dshupBtn", onClick: async () => { const r = await dsh.settings.export(); setStatus(r.ok ? "已导出" : (r.canceled ? "已取消" : "导出失败")); }, children: "导出设置" }),
					jsx("button", { type: "button", className: "dshupBtn", onClick: async () => { const r = await dsh.settings.import(); setStatus(r.ok ? "已导入" : (r.canceled ? "已取消" : "导入失败")); if (r.ok) dsh.data.info().then(setInfo).catch(() => {}); }, children: "导入设置" }),
					jsx("button", { type: "button", className: "dshupBtnDanger", onClick: async () => { const r = await dsh.data.clearCache(); setStatus(r.ok ? "缓存已清理" : "清理失败"); }, children: "清理浏览器缓存" }),
					jsx("span", { className: "dshupHint", children: status })
				] })
			] });
		}

		function MarketSection() {
			const dsh = api();
			const [query, setQuery] = useState("");
			const [page, setPage] = useState(1);
			const [mirror, setMirror] = useState("direct");
			const [list, setList] = useState(null);
			const [mine, setMine] = useState(null);
			const [speed, setSpeed] = useState("");
			const [log, setLog] = useState("");
			const append = (line) => setLog((p) => (p ? p + "\n" : "") + line);
			useEffect(() => {
				if (!dsh) return;
				const off = dsh.market.onInstallProgress((p) => { if (p && p.line) append(p.line); });
				return () => { if (typeof off === "function") off(); };
			}, [dsh]);
			const loadList = useCallback(async (q, pg) => {
				if (!dsh) return;
				setList({ loading: true });
				const r = await dsh.market.list({ query: q, page: pg });
				setList(r);
			}, [dsh]);
			useEffect(() => { loadList(query, page); }, [loadList, query, page]);
			const loadMine = async () => {
				if (!dsh) return;
				setMine(await dsh.market.installed());
			};
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "插件市场" }), jsx(MissingClient, {})] });
			const items = (list && list.items) || [];
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "插件市场" }),
				jsx("p", { className: "dshupHint", children: "GitHub topic:dsh-plugin · 一键安装到官方 dsh web profile" }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("input", { className: "dshupInput", value: query, placeholder: "搜索插件", onChange: (e) => setQuery(e.target.value), onKeyDown: (e) => { if (e.key === "Enter") { setPage(1); loadList(e.target.value, 1); } } }),
					jsx("button", { type: "button", className: "dshupBtn", onClick: () => { setPage(1); loadList(query, 1); }, children: "搜索" }),
					jsx("button", { type: "button", className: "dshupBtn", onClick: async () => {
						setSpeed("测速中…");
						const r = await dsh.market.speedtest();
						const fastest = r.fastest ? `${r.fastest.name} ${r.fastest.ms}ms` : "无可用镜像";
						setSpeed("最快：" + fastest + "；" + (r.results || []).map((x) => `${x.name}:${x.ok ? x.ms + "ms" : "失败"}`).join(" / "));
						if (r.fastest) setMirror(r.fastest.id);
					}, children: "测速" }),
					jsx("button", { type: "button", className: "dshupBtn", onClick: loadMine, children: "我的插件" })
				] }),
				jsx(Row, { label: "下载镜像", desc: "安装插件时走 GitHub 直连或加速前缀", children: jsxs("select", { className: "dshupSelect", value: mirror, onChange: (e) => setMirror(e.target.value), children: [
					jsx("option", { value: "direct", children: "直连（github.com）" }),
					jsx("option", { value: "ghfast", children: "ghfast.top" }),
					jsx("option", { value: "ghproxy", children: "gh-proxy.com" }),
					jsx("option", { value: "ghproxy-net", children: "mirror.ghproxy.com" }),
					jsx("option", { value: "ghdl", children: "gh.ddlc.top" }),
					jsx("option", { value: "ghp", children: "ghp.ci" })
				] }) }),
				speed ? jsx("div", { className: "dshupMono", children: speed }) : null,
				jsx("div", { className: "dshupLabel", children: "插件列表" }),
				!list || list.loading ? jsx("div", { className: "dshupBanner", children: "插件列表加载中…" }) :
				!list.ok ? jsx("div", { className: "dshupBanner", children: list.error || "插件列表获取失败" }) :
				items.length === 0 ? jsx("div", { className: "dshupBanner", children: "没有匹配的插件" }) :
				jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8 }, children: items.map((item) => jsxs("div", { className: "dshupPlugin", children: [
					jsx("h3", { children: item.fullName }),
					jsx("p", { children: item.description || "暂无简介" }),
					jsxs("div", { className: "dshupMono", children: ["★ ", item.stars || 0, " · ", item.language || "n/a"] }),
					jsxs("div", { className: "dshupActs", children: [
						jsx("button", { type: "button", className: "dshupBtnPri", onClick: async () => {
							append("开始一键安装 " + (item.cloneUrl || item.htmlUrl));
							const r = await dsh.market.install({ repo: item.cloneUrl || item.htmlUrl, mirrorId: mirror });
							append(r.ok ? (r.note || "完成") : (r.error || "失败"));
						}, children: "一键安装" }),
						jsx("button", { type: "button", className: "dshupBtn", onClick: async () => {
							const repo = item.cloneUrl || item.htmlUrl;
							const prompt = `请帮我安装这个 DeepSeek Harness 插件：\n名称：${item.fullName}\n仓库：${repo}\n请使用 dsh plugin --profile web add 安装到 web profile。`;
							try { await navigator.clipboard.writeText(prompt); append("已复制「交给 AI 安装」提示词"); }
							catch { append(prompt); }
						}, children: "交给 AI 安装" }),
						jsx("button", { type: "button", className: "dshupBtn", onClick: () => dsh.openExternal(item.cloneUrl || item.htmlUrl).catch(() => {}), children: "打开仓库" })
					] })
				] }, item.fullName)) }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("button", { type: "button", className: "dshupBtn", disabled: page <= 1, onClick: () => setPage((p) => Math.max(1, p - 1)), children: "上一页" }),
					jsx("span", { className: "dshupMono", children: list && list.ok ? `第 ${list.page} / ${list.totalPages} 页 · 共 ${list.total}` : "" }),
					jsx("button", { type: "button", className: "dshupBtn", onClick: () => setPage((p) => p + 1), children: "下一页" })
				] }),
				jsx("div", { className: "dshupLabel", children: "我的插件" }),
				mine ? jsxs("div", { children: [
					jsxs("div", { className: "dshupBanner", children: ["我的插件（", ((mine.plugins || []).length), "）"] }),
					(mine.plugins || []).map((p) => jsxs("div", { className: "dshupPlugin", children: [
						jsx("h3", { children: p.name }),
						jsx("div", { className: "dshupMono", children: p.version || "" }),
						jsx("button", { type: "button", className: "dshupBtnDanger", onClick: async () => {
							append("开始卸载 " + p.name);
							const r = await dsh.market.uninstall({ name: p.name });
							append(r.ok ? (r.note || "完成") : (r.error || "失败"));
							loadMine();
						}, children: "卸载" })
					] }, p.name))
				] }) : jsx("div", { className: "dshupBanner", children: "点击「我的插件」查看已安装项。卸载入口在此。" }),
				jsx("div", { className: "dshupLog", children: log })
			] });
		}

		function StatsSection() {
			const dsh = api();
			const [data, setData] = useState(null);
			useEffect(() => {
				if (!dsh) return;
				dsh.stats.get().then(setData).catch((e) => setData({ available: false, reason: String(e && e.message || e) }));
				const off = dsh.stats.onUpdated(setData);
				return () => { if (typeof off === "function") off(); };
			}, [dsh]);
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "统计" }), jsx(MissingClient, {})] });
			if (!data) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "统计" }), jsx("div", { className: "dshupBanner", children: "正在读取统计…" })] });
			if (data.available !== true) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "统计" }), jsxs("div", { className: "dshupBanner", children: ["暂无统计：", data.reason || "还没有本地会话"] })] });
			const daily = data.daily || {};
			const now = new Date();
			const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
			const days = [];
			for (let i = 13; i >= 0; i -= 1) {
				const d = new Date(now);
				d.setDate(now.getDate() - i);
				const key = ymd(d);
				days.push({ key, v: daily[key] || 0 });
			}
			const max = Math.max(1, ...days.map((x) => x.v));
			const heat = days.map((x) => {
				const lv = x.v <= 0 ? 0 : x.v / max < 0.25 ? 1 : x.v / max < 0.5 ? 2 : x.v / max < 0.75 ? 3 : 4;
				return jsx("i", { className: "lv" + lv, title: x.key + ": " + x.v }, x.key);
			});
			const calCols = [];
			const start = new Date(now);
			start.setDate(now.getDate() - 89);
			start.setDate(start.getDate() - start.getDay());
			const todayKey = ymd(now);
			let cursor = new Date(start);
			while (cursor <= now || calCols.length < 13) {
				const col = [];
				const colKey = ymd(cursor);
				for (let r = 0; r < 7; r += 1) {
					const key = ymd(cursor);
					const v = daily[key] || 0;
					const lv = v <= 0 ? 0 : v < 1000 ? 1 : v < 5000 ? 2 : v < 20000 ? 3 : 4;
					col.push(jsx("i", { className: "lv" + lv + (key === todayKey ? " today" : ""), title: key + ": " + v }, key));
					cursor.setDate(cursor.getDate() + 1);
				}
				calCols.push(jsx("div", { className: "dshupCalCol", children: col }, colKey));
				if (cursor > now && calCols.length >= 13) break;
				if (calCols.length > 20) break;
			}
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "统计" }),
				jsx("p", { className: "dshupHint", children: "扫描本地会话，快照秒开，后台增量刷新" }),
				jsxs("div", { className: "dshupCards", children: [
					jsxs("div", { className: "dshupCard", children: [jsx("div", { className: "k", children: "累计 Token" }), jsx("div", { className: "v", children: fmtNum(data.totalTokens) })] }),
					jsxs("div", { className: "dshupCard", children: [jsx("div", { className: "k", children: "今日 Token" }), jsx("div", { className: "v", children: fmtNum(data.todayTokens) })] }),
					jsxs("div", { className: "dshupCard", children: [jsx("div", { className: "k", children: "任务数" }), jsx("div", { className: "v", children: fmtNum(data.turnCount) })] }),
					jsxs("div", { className: "dshupCard", children: [jsx("div", { className: "k", children: "会话数" }), jsx("div", { className: "v", children: fmtNum(data.sessionCount) })] }),
					jsxs("div", { className: "dshupCard", children: [jsx("div", { className: "k", children: "最长任务" }), jsx("div", { className: "v", children: fmtMs(data.longestTaskMs) })] })
				] }),
				jsx(Row, { label: "Token 构成", desc: `输入 ${fmtNum(data.totalInputTokens)} · 输出 ${fmtNum(data.totalOutputTokens)} · 推理 ${fmtNum(data.totalReasoningTokens)}`, children: null }),
				jsx("div", { className: "dshupLabel", children: "近 14 天" }),
				jsx("div", { className: "dshupHeat", children: heat }),
				jsx("div", { className: "dshupLabel", children: "近三个月" }),
				jsx("div", { className: "dshupCal", children: calCols })
			] });
		}

		function VoiceSection() {
			const dsh = api();
			const [cfg, setCfg] = useState(null);
			const [pane, setPane] = useState("remote");
			const [status, setStatus] = useState("");
			const [log, setLog] = useState("");
			const append = (line) => setLog((p) => (p ? p + "\n" : "") + line);
			const load = useCallback(async () => {
				if (!dsh) return;
				const c = await dsh.asr.config.get();
				setCfg(c);
				setPane(c.mode === "local" ? "local" : "remote");
			}, [dsh]);
			useEffect(() => { load(); }, [load]);
			useEffect(() => {
				if (!dsh) return;
				const off = dsh.asr.local.onProgress((ev) => append(ev && ev.message ? ev.message : JSON.stringify(ev)));
				return () => { if (typeof off === "function") off(); };
			}, [dsh]);
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "语音输入" }), jsx(MissingClient, {})] });
			if (!cfg) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "语音输入" }), jsx("div", { className: "dshupBanner", children: "加载中…" })] });
			const patch = (key, value) => setCfg((p) => ({ ...p, [key]: value }));
			const deployed = !!(cfg.localDeployed);
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "语音输入" }),
				jsx("p", { className: "dshupHint", children: "dshup 客户端语音识别：远程 MiMo ASR 或本地 FunASR" }),
				jsxs("div", { className: "dshupMode", children: [
					jsx("button", { type: "button", className: "dshupModeBtn", "data-on": pane === "remote" ? "1" : "0", onClick: () => { setPane("remote"); patch("mode", "remote"); }, children: "远程识别" }),
					jsx("button", { type: "button", className: "dshupModeBtn", "data-on": pane === "local" ? "1" : "0", onClick: () => { setPane("local"); patch("mode", "local"); }, children: "本地部署" })
				] }),
				pane !== "local" ? jsxs("div", { children: [
					jsx(Row, { label: "语言", desc: "auto / zh / en", children: jsxs("select", { className: "dshupSelect", value: cfg.language || "zh", onChange: (e) => patch("language", e.target.value), children: [
						jsx("option", { value: "auto", children: "auto" }),
						jsx("option", { value: "zh", children: "zh" }),
						jsx("option", { value: "en", children: "en" })
					] }) }),
					jsx(Row, { label: "远程接口", desc: "MiMo ASR Base URL", children: jsx("input", { className: "dshupInput", value: cfg.remoteBaseUrl || "", onChange: (e) => patch("remoteBaseUrl", e.target.value) }) }),
					jsx(Row, { label: "模型", children: jsx("input", { className: "dshupInput", value: cfg.model || "", onChange: (e) => patch("model", e.target.value) }) }),
					jsx(Row, { label: "API Key", children: jsx("input", { className: "dshupInput", type: "password", value: cfg.apiKey || "", onChange: (e) => patch("apiKey", e.target.value) }) })
				] }) : jsxs("div", { children: [
					jsx("div", { className: "dshupBanner", children: deployed ? "本地模型已部署" : "本地模型未部署" }),
					jsx(Row, { label: "本地服务地址", desc: "FunASR HTTP 地址", children: jsx("input", { className: "dshupInput", value: cfg.localUrl || "http://127.0.0.1:10095", onChange: (e) => patch("localUrl", e.target.value) }) }),
					jsxs("div", { className: "dshupActs", children: [
						jsx("button", { type: "button", className: "dshupBtnPri", onClick: async () => { append("开始一键部署…"); const r = await dsh.asr.local.deploy(); append(r && r.ok === false ? (r.error || "失败") : "部署结束"); load(); }, children: "一键部署本地模型" }),
						jsx("button", { type: "button", className: "dshupBtn", onClick: async () => { const r = await dsh.asr.local.start(); append(r && r.error ? r.error : "已请求启动"); load(); }, children: "启动" }),
						jsx("button", { type: "button", className: "dshupBtn", onClick: async () => { const r = await dsh.asr.local.stop(); append(r && r.error ? r.error : "已请求停止"); load(); }, children: "停止" })
					] })
				] }),
				jsxs("div", { className: "dshupActs", children: [
					jsx("button", { type: "button", className: "dshupBtnPri", onClick: async () => {
						await dsh.asr.config.set({
							mode: pane === "local" ? "local" : "remote",
							language: cfg.language,
							remoteBaseUrl: cfg.remoteBaseUrl,
							model: cfg.model,
							apiKey: cfg.apiKey,
							localUrl: cfg.localUrl,
						});
						setStatus("已保存");
					}, children: "保存语音配置" }),
					jsx("span", { className: "dshupHint", children: status })
				] }),
				jsx("div", { className: "dshupLog", children: log })
			] });
		}

		function AboutSection() {
			const dsh = api();
			const [info, setInfo] = useState({ text: "读取版本中…", extra: "" });
			const load = async () => {
				if (!dsh) return;
				setInfo({ text: "正在检查更新…", extra: "" });
				const r = await dsh.update.check();
				let extra = "";
				if (r.hasUpdate) extra = "发现新版本 " + r.latest;
				else if (r.error) extra = "检查更新失败：" + r.error;
				else extra = "已是最新版本，或暂未发布更新";
				setInfo({ text: `当前版本 ${r.current || "?"} ` + (r.latest ? `· 最新 ${r.latest}` : ""), extra });
			};
			useEffect(() => { load(); }, [dsh]);
			if (!dsh) return jsxs("div", { className: "dshupSec", children: [jsx("h2", { children: "关于" }), jsx(MissingClient, {})] });
			return jsxs("div", { className: "dshupSec", children: [
				jsx("h2", { children: "关于" }),
				jsx("p", { className: "dshupHint", children: "dshup 桌面客户端" }),
				jsx(Row, { label: "DeepSeek Harness 桌面客户端", desc: info.text, children: jsx("button", { type: "button", className: "dshupBtn", onClick: load, children: "检查更新" }) }),
				jsx(Row, { label: "项目仓库", desc: "https://github.com/zhangjiabo522/dshup", children: jsx("button", { type: "button", className: "dshupBtn", onClick: () => dsh.openExternal("https://github.com/zhangjiabo522/dshup"), children: "打开仓库" }) }),
				jsx("div", { className: "dshupMono", children: info.extra })
			] });
		}

		function encodeWav(float32, sampleRate) {
			const n = float32.length;
			const buffer = new ArrayBuffer(44 + n * 2);
			const view = new DataView(buffer);
			const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
			writeStr(0, "RIFF");
			view.setUint32(4, 36 + n * 2, true);
			writeStr(8, "WAVE");
			writeStr(12, "fmt ");
			view.setUint32(16, 16, true);
			view.setUint16(20, 1, true);
			view.setUint16(22, 1, true);
			view.setUint32(24, sampleRate, true);
			view.setUint32(28, sampleRate * 2, true);
			view.setUint16(32, 2, true);
			view.setUint16(34, 16, true);
			writeStr(36, "data");
			view.setUint32(40, n * 2, true);
			let off = 44;
			for (let i = 0; i < n; i++) {
				const s = Math.max(-1, Math.min(1, float32[i]));
				view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
				off += 2;
			}
			const bytes = new Uint8Array(buffer);
			let bin = "";
			for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
			return btoa(bin);
		}

		function downsample(buffer, from, to) {
			if (from === to) return buffer;
			const ratio = from / to;
			const outLen = Math.round(buffer.length / ratio);
			const out = new Float32Array(outLen);
			for (let i = 0; i < outLen; i++) {
				const start = Math.round(i * ratio);
				out[i] = buffer[start] || 0;
			}
			return out;
		}

		function captureComposerInsertion(inputActions) {
			if (inputActions && typeof inputActions.captureInsertion === "function" && typeof inputActions.insertText === "function") {
				return { inputActions, span: inputActions.captureInsertion() };
			}
			const textarea = document.querySelector("textarea");
			return textarea ? { textarea, value: textarea.value || "" } : null;
		}

		function insertComposerText(text, target) {
			if (!text || !target) return false;
			if (target.inputActions) return target.inputActions.insertText(text, target.span);
			const ta = target.textarea;
			if (!ta || !ta.isConnected || ta.value !== target.value || ta.disabled || ta.readOnly) return false;
			const proto = window.HTMLTextAreaElement.prototype;
			const desc = Object.getOwnPropertyDescriptor(proto, "value");
			const next = target.value + text;
			if (desc && desc.set) desc.set.call(ta, next); else ta.value = next;
			ta.dispatchEvent(new Event("input", { bubbles: true }));
			ta.focus();
			return true;
		}

		function openVoiceSettings() {
			const dsh = api();
			if (dsh && typeof dsh.openVoiceSettings === "function") {
				dsh.openVoiceSettings().catch(() => {});
			}
			const clickVoice = () => {
				const dialog = document.querySelector('[role="dialog"]') || document.querySelector('[aria-modal="true"]');
				const voice = [...(dialog ? dialog : document).querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "语音输入");
				if (voice) voice.click();
			};
			let settingsBtn = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "设置");
			if (!settingsBtn) {
				const open = [...document.querySelectorAll("button")].find((x) => (x.getAttribute("aria-label") || "").includes("打开侧边栏"));
				if (open) open.click();
				setTimeout(() => {
					settingsBtn = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "设置");
					if (settingsBtn) settingsBtn.click();
					setTimeout(clickVoice, 600);
				}, 400);
				return;
			}
			settingsBtn.click();
			setTimeout(clickVoice, 600);
		}

		function VoiceButton({ inputActions } = {}) {
			const dsh = api();
			const recRef = useRef(null);
			const [rec, setRec] = useState(false);
			const [ready, setReady] = useState(true);
			const [pendingText, setPendingText] = useState("");
			useEffect(() => {
				if (!dsh) { setReady(false); return; }
				dsh.asr.config.get().then((c) => {
					const ok = c.mode === "local" ? !!(c.localRunning || c.localDeployed) : !!(c.apiKey && String(c.apiKey).trim());
					setReady(ok);
				}).catch(() => setReady(false));
			}, [dsh]);
			const onClick = async () => {
				if (!dsh) return;
				if (!ready) { openVoiceSettings(); return; }
				if (recRef.current) {
					recRef.current.stop();
					return;
				}
				try {
					const insertion = captureComposerInsertion(inputActions);
					const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
					const ctx = new AudioContext();
					const source = ctx.createMediaStreamSource(stream);
					const processor = ctx.createScriptProcessor(4096, 1, 1);
					const chunks = [];
					processor.onaudioprocess = (e) => {
						chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
					};
					source.connect(processor);
					processor.connect(ctx.destination);
					const stop = async () => {
						processor.disconnect();
						source.disconnect();
						stream.getTracks().forEach((t) => t.stop());
						await ctx.close();
						recRef.current = null;
						setRec(false);
						let len = 0;
						for (const c of chunks) len += c.length;
						const merged = new Float32Array(len);
						let o = 0;
						for (const c of chunks) { merged.set(c, o); o += c.length; }
						const pcm = downsample(merged, ctx.sampleRate || 48000, 16000);
						const wav = encodeWav(pcm, 16000);
						const r = await dsh.asr.transcribe(wav);
						if (r && r.ok && r.text && !insertComposerText(r.text, insertion)) {
							setPendingText((previous) => previous ? previous + "\n" + r.text : r.text);
						}
					};
					recRef.current = { stop };
					setRec(true);
				} catch (e) {
					openVoiceSettings();
				}
			};
			return jsxs(jsxRuntime.Fragment, { children: [jsx("button", {
				type: "button",
				className: "dshupVoiceBtn",
				"aria-label": "语音输入",
				title: ready ? (rec ? "正在录音，点击结束" : "语音输入") : "语音输入（未配置）",
				"data-rec": rec ? "1" : "0",
				onClick,
				children: jsxs("svg", { viewBox: "0 0 16 16", width: "16", height: "16", "aria-hidden": true, children: [
					jsx("rect", { x: "6", y: "1.5", width: "4", height: "8", rx: "2", fill: "currentColor" }),
					jsx("path", { d: "M3.5 7.5a4.5 4.5 0 0 0 9 0", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" }),
					jsx("path", { d: "M8 12v2.5", fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round" })
				] })
			}), pendingText ? jsx("button", {
				type: "button",
				className: "dshupBtn",
				title: "输入内容已变化，点击填入当前光标位置：" + pendingText,
				onClick: () => {
					if (insertComposerText(pendingText, captureComposerInsertion(inputActions))) setPendingText("");
				},
				children: "填入语音文字",
			}) : null] });
		}

		const inject = ["slots"];
		function apply(ctx) {
			const sections = [
				{ id: "system", order: 50, label: "系统设置", Component: SystemSection },
				{ id: "personal", order: 55, label: "个性化", Component: PersonalSection },
				{ id: "data", order: 60, label: "数据与存储", Component: DataSection },
				{ id: "market", order: 65, label: "插件市场", Component: MarketSection },
				{ id: "stats", order: 70, label: "统计", Component: StatsSection },
				{ id: "voice", order: 75, label: "语音输入", Component: VoiceSection },
				{ id: "about", order: 80, label: "关于", Component: AboutSection },
			];
			for (const sec of sections) {
				ctx.slots.inject("settings.section", () => ctx.slots.register({
					name: "settings.section",
					id: sec.id,
					order: sec.order,
					label: () => sec.label,
				}, sec.Component));
			}
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "dshup-voice",
				order: 50,
			}, VoiceButton));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
