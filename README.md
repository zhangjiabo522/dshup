# dshup — DeepSeek Harness Windows 客户端

> GitHub: <https://github.com/zhangjiabo522/dshup>

一个开箱即用的 Windows 桌面客户端：**自动检测**依赖（Node.js / pnpm / DeepSeek Harness），
缺失时**自动从国内镜像安装**（不写入系统 PATH、不碰注册表、不动 npm 全局），
安装好后**自动启动** `dsh web`，并**直接在客户端窗口内嵌显示** `http://127.0.0.1:3080/`，
无需手动打开浏览器。

应用 Logo 使用 `C:\Users\zjb\Desktop\deep.jpg`（已复制到 `assets/`，并生成 `icon.png` / `icon.ico`）。

---

## 功能一览

| 场景 | 客户端行为 |
| --- | --- |
| 3080 端口已在运行 dsh | 直接内嵌显示页面（不重复启动） |
| 已安装 dsh（PATH 中） | 直接启动 `dsh web` |
| 本地有已构建的 deepseek-harness 源码仓库 | 优先用仓库 `pnpm dsh web` 启动，不重复下载 |
| 什么都没有 | 自动下载 Node.js（npmmirror）→ 私有目录装 pnpm → 私有目录装 `@deepseek-ai/dsh` → 启动 |

## 客户端设置页（标题栏齿轮按钮进入）

专门的设置页面，左侧多 tab：

- **系统设置**：开机自启动开关（勾选即注册/取消 `HKCU\...\Run`）；关闭客户端时停止 dsh 服务开关
- **个性化**：编辑用户自定义提示词，保存到 `$DSH_HOME/AGENTS.md`（dsh 官方机制）——
  **每次对话自动附加在系统提示词后面**（agent-instructions 注入）
- **网页设置**：iframe 内嵌 dsh 页面并自动打开原"设置"面板（通用设置 / 模型 / 插件 / Agent 预设等全部原功能原样可用）

客户端本地设置保存在 `%LOCALAPPDATA%\DeepSeekHarnessClient\client-settings.json`。

所有自动安装都落在私有目录：

```
%LOCALAPPDATA%\DeepSeekHarnessClient\runtime\
├── node\                       # 私有 Node.js（如需下载时）
└── node_modules\               # 私有 pnpm / @deepseek-ai/dsh（npm --prefix 安装）
```

系统里已有的、版本达标的 Node.js（≥22.19）与 pnpm 会**优先复用**，不会被改动。

## 国内镜像

- npm 包源：`https://registry.npmmirror.com`
- Node.js 二进制：`https://npmmirror.com/mirrors/node`
- Electron 二进制（构建依赖）：`https://npmmirror.com/mirrors/electron/`（见 `.npmrc`）

## 系统代理自动适配

客户端会自动读取 Windows 系统代理（注册表 `Internet Settings`，兼容 Clash 等代理工具的
fake-IP DNS），下载 Node 与 npm 安装都优先走代理、失败自动回退直连；本地 3080 端口检测不走代理。

## 运行（开发模式）

```powershell
cd D:\DS\dsh-windows-client
npm install        # 已装过可跳过
npm start          # 启动客户端
```

或双击根目录的 `启动客户端.bat`。

## 打包成独立 exe

```powershell
npm run package:win
```

产物在 `dist\DeepSeekHarnessClient-win32-x64\DeepSeekHarnessClient.exe`，可直接分发
（注意：Electron 客户端本身是自包含的，不需要用户机器安装 Node.js —— 引导逻辑在客户端内完成）。

## 制作并安装 Setup 安装程序（推荐）

```powershell
npm run dist:installer
```

产物在 `release\DeepSeekHarnessClient-Setup-1.0.0.exe`（NSIS 向导式安装器，per-user 安装，无需管理员）：

- 安装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness\`
- 自动创建**桌面快捷方式**与**开始菜单快捷方式**（"DeepSeek Harness"）
- 支持从"设置 → 应用"或 `Uninstall DeepSeek Harness.exe` 正常卸载
- 静默安装/升级：`DeepSeekHarnessClient-Setup-1.0.0.exe /S`
- 数据（Chromium 缓存）落在 `%LOCALAPPDATA%\DeepSeekHarnessClient\`，卸载不影响 dsh 本体

## 无界面自检

```powershell
npm run test:bootstrap   # 检测逻辑 + “已在运行”分支
node test-install.js     # 完整安装链路（Node→pnpm→dsh，走国内镜像，安全可重复执行）
electron . --smoke-test  # 冒烟测试：窗口→引导→内嵌页面加载成功即退出（exit 0）
```

本仓库开发机上已实测通过：系统代理 `127.0.0.1:7890` 下自动下载 Node v22.23.2（npmmirror）、
pnpm 11.7.0、`@deepseek-ai/dsh` 0.1.0-rc.6 到私有目录；独立端口 3090 端到端启动返回
HTTP 200；`--smoke-test` 成功加载 `http://127.0.0.1:3080/`。

## 说明与注意事项

- 客户端只会停止**由自己启动**的 dsh 进程；若 dsh 本来就在运行，关闭客户端不会影响它。
- 若 3080 被其他程序占用，`dsh web` 会启动失败，请先释放端口。
- 客户端窗口内点击的站外链接会交给系统默认浏览器打开，避免破坏"内嵌展示"体验。
- `bootstrap.js` 是纯 Node 模块，可脱离 Electron 单独测试/复用。

## 项目结构

```
main.js             Electron 主进程：窗口、引导编排、生命周期
bootstrap.js        检测 / 安装 / 启动逻辑（纯 Node）
preload.js          渲染进程安全桥
renderer/           启动界面（Logo + 进度 + 日志 + 重试）
assets/             deep.jpg / icon.png / icon.ico
test-bootstrap.js   无界面检测测试
test-install.js     无界面安装链路测试
```
