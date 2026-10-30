# dshup — DeepSeek Harness 桌面客户端

[项目仓库](https://github.com/zhangjiabo522/dshup) · [下载安装包](https://github.com/zhangjiabo522/dshup/releases)

桌面客户端会检测 Node.js、pnpm 和 DeepSeek Harness，按需在用户私有目录安装依赖，然后在窗口内打开本机 `dsh web`。支持 Windows、macOS，以及 Ubuntu 22.04 / 24.04 的 amd64 桌面环境。Ubuntu 的安装包为 `.deb`，客户端版本为 1.0.3。

客户端提供托盘、开机自启、镜像与代理设置、语音输入、用量统计、数据目录管理和更新检查。内置 `dshup-client-settings` 插件把客户端设置与语音入口接入 Harness；标题栏齿轮和托盘菜单也可以打开客户端设置。

## Ubuntu 安装与升级

在 Release 下载 `dshup-1.0.3-linux-amd64.deb`，在下载目录执行：

```bash
sudo apt install ./dshup-1.0.3-linux-amd64.deb
```

`amd64` 表示 64 位 Intel / AMD 架构。安装后在应用列表打开 **DeepSeek Harness**，也可执行 `dshup`。应用程序安装到 `/opt/DeepSeek Harness/`，菜单入口为 `/usr/share/applications/dshup.desktop`。

升级时先从托盘退出客户端，再用同样的 `sudo apt install ./新版本.deb` 安装新包。升级包保留用户目录中的设置、会话和插件。客户端“检查更新”会选择本系统和架构对应的安装包；不存在匹配产物时打开 Release 页面。下载后仍需手动安装，不会静默替换系统文件。

卸载应用程序：

```bash
sudo apt remove dshup
```

卸载不会删除个人数据。若已启用开机自启，可先在客户端设置中关闭。

Ubuntu 24.04 对用户命名空间的限制由 Electron Builder 的 `.deb` 安装脚本处理：安装适用于 `/opt/DeepSeek Harness/dshup` 的 AppArmor 配置，Ubuntu 22.04 不支持此配置时自动跳过。请通过 `.deb` 安装；直接运行解压出的二进制不会执行这一步。该配置依据 [Ubuntu 24.04 官方说明](https://documentation.ubuntu.com/release-notes/24.04/#unprivileged-user-namespace-restrictions)，无需关闭系统 AppArmor 或用户命名空间限制。

## 数据目录与开机自启

| 内容 | Ubuntu 默认位置 | 覆盖方式 |
| --- | --- | --- |
| 客户端设置、日志、私有运行时 | `~/.local/share/DeepSeekHarnessClient/` | `XDG_DATA_HOME` |
| Chromium 窗口缓存与浏览器认证 | `~/.local/share/DeepSeekHarnessClient/user-data/` | 随客户端数据目录 |
| 开机自启条目 | `~/.config/autostart/dshup.desktop` | `XDG_CONFIG_HOME` |
| Harness 会话、模型和插件配置 | `~/.dsh/` | `DSH_HOME` |

`XDG_DATA_HOME` 和 `XDG_CONFIG_HOME` 应为绝对路径。开机自启只在系统设置中启用后写入，关闭开关会移除该条目；登录桌面后以后台模式启动 Harness。图形桌面会话必须继承你设置的环境变量，才能使用相同的自定义数据目录。

Windows 客户端数据位于 `%LOCALAPPDATA%\DeepSeekHarnessClient\`，macOS 位于 `~/Library/Application Support/DeepSeekHarnessClient/`。私有 Node.js 和 npm 包位于各平台客户端目录下的 `runtime/`。客户端不会写入系统 PATH 或修改 npm 全局包。

## Harness 0.2 认证与启动

新安装运行时使用 `@deepseek-ai/dsh@0.2.1-rc.5`。可用的已有运行时或源码仓库仍可复用；客户端安装包升级和 Harness 运行时升级是两件事，不会因安装新 `.deb` 就强制覆盖已有运行时。

Harness 0.2 启动时提供带令牌的登录地址。官方服务在当前进程中允许多次兑换该启动令牌；客户端在引导时只兑换一次，将认证 cookie 写入内嵌浏览器，再加载不带令牌的地址。重试页面或打开设置时复用 cookie。客户端不会在普通日志中显示令牌值。

默认服务地址为 `http://127.0.0.1:3080/`；需要独立实例时，可在启动前设置 `DSH_PORT`。如果端口被其他程序占用，或已运行的 Harness 无法用当前 cookie 认证，客户端会报告问题，不会结束不属于自己的进程。只会停止由当前客户端启动且仍持有的服务进程。

系统里满足要求的 Node.js（22.19 或更新版本）优先复用。缺少依赖时按设置选择国内镜像或官方源安装。默认镜像为 npm 的 `registry.npmmirror.com` 和 Node.js 的 `npmmirror.com/mirrors/node`；Linux/macOS 可使用代理环境变量，Windows 另支持检测系统代理。

## 本地开发与打包

构建需要 Node.js 22.19 或更新版本及 npm。Ubuntu 开发环境需要图形会话；无桌面的构建机可使用 Xvfb 进行窗口测试。

```bash
git clone https://github.com/zhangjiabo522/dshup.git
cd dshup
npm ci
npm run test:desktop
npm run test:detect
npm start
```

Ubuntu 安装包：

```bash
npm run dist:deb
```

Windows 安装包：

```powershell
npm run dist:installer
```

macOS 按本机构建架构选择：

```bash
npx electron-builder --mac dmg zip --arm64 --publish never
npx electron-builder --mac dmg zip --x64 --publish never
```

产物位于 `release/`。Windows 保持 `dshup-Setup-1.0.3.exe` 的既有命名；macOS 文件名包含 `arm64` 或 `x64`，避免不同架构覆盖。`npm run package:win` 仍可生成免安装目录。

## 检查与持续集成

`npm run test:desktop` 检查自启文件、路径处理、版本比较、更新产物选择、插件命令参数、桌面通信访问边界、缓存登录状态和新旧输入框的语音填入。`npm run test:detect` 只读取当前环境，不启动或安装 Harness。`npm run test:bootstrap` 在 Linux/macOS 的临时目录中检查服务生命周期、令牌与 cookie、外部端口冲突和失败清理，不访问外部网络；Windows 暂跳过该组进程测试。`node test-install.js` 验证完整安装链路，需要网络，执行前应检查脚本中的目标目录。

安装 `.deb` 后，可用普通用户运行隔离窗口检查：

```bash
xvfb-run -a dbus-run-session -- npm run test:smoke:linux
```

该检查使用临时 HOME、XDG 和 DSH_HOME，选择独立端口，创建本地模拟服务，验证客户端启动、令牌兑换、cookie 和页面标记。模拟服务故意只接受一次令牌兑换，以检出客户端重复兑换的回归；这比官方服务的令牌使用规则更严格。完成后清理临时目录，不读取或修改真实 `~/.dsh`，不传入关闭沙箱的启动参数。它不验证模型推理或真实 Harness 的安装下载。若默认 Node.js 版本偏旧，可用 `DSHUP_SMOKE_NODE=/绝对路径/node` 指定测试运行时。

GitHub Actions 配置了 Ubuntu 22.04 / 24.04 amd64 的构建、安装与隔离窗口检查，同时构建 Windows x64 和 macOS 双架构。Windows/macOS 当前只做首启存活检查。每次推送、拉取请求或手动触发都会运行；只有推送 `v*` 标签且全部构建成功时才发布 Release。Linux Release 使用 Ubuntu 22.04 构建，24.04 产物作为独立验证附件保存。工作流配置不代表测试已运行，通过情况以对应 Actions 记录为准。

## 项目结构

| 路径 | 用途 |
| --- | --- |
| `main.js` / `preload.js` | Electron 窗口、生命周期与安全通信桥 |
| `bootstrap.js` | 跨平台检测、安装、启动与认证 |
| `desktop-platform.js` | 自启文件、版本比较和安装包选择 |
| `renderer/` | 启动界面和客户端设置 |
| `plugin/dshup-client-settings/` | Harness 内客户端设置与语音入口 |
| `scripts/smoke-linux.js` | 隔离的 Linux 安装包窗口检查 |
| `.github/workflows/build-release.yml` | 跨平台构建、验证与发布 |
