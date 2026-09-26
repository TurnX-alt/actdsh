# actdsh — DeepSeek Harness 桌面版（Windows 免安装）

actdsh 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的桌面分发仓库。它把官方发布版本组装成一个免安装的 Windows 应用：下载 zip、解压、双击，不需要安装 Node.js、npm 或任何其他开发环境。应用窗口内就是完整的 dsh 官方 Web 界面，配置、会话、技能、插件数据与官方版完全通用。本仓库的自动化流程每天检查一次上游新版本，产物始终与上游同版本。

- 上游官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 本项目性质：第三方打包分发，非 deepseek-ai 官方产品（见文末声明）

上游从 2026-09-24 起自己发布官方桌面版，Windows 与 macOS 都能直接从 DeepSeek 的 CDN 下载。macOS 请用官方版，本仓库不再产出 macOS 包（原因见[与官方桌面版的区别](#与官方桌面版的区别)）。两边读同一份 `~/.dsh` 数据，配置和会话互相通用，装了哪个都能接着用另一个的数据。

## 下载与安装

到 [Releases 页面](../../releases) 下载最新的 zip：

| 系统 | 文件 | 使用方式 |
| --- | --- | --- |
| Windows 10/11（x64） | `actdsh-win-x64-<版本>.zip` | 解压到任意位置，双击 actdsh.exe 即用 |
| macOS（Apple 芯片） | 用官方桌面版 | 见下文 [macOS 怎么拿](#macos-怎么拿) |

### Windows：解压即用，位置你说了算

把 zip 解压到你喜欢的任意位置（桌面、D 盘、U 盘都可以），双击其中的 actdsh.exe 即可使用。没有安装器、不写注册表、不碰系统里已有的任何程序——应用需要的所有组件都在这个文件夹里。

首次运行时，Windows SmartScreen 可能提示「Windows 已保护你的电脑」。这是因为程序未购买商业代码签名证书（见常见问题）。确认你下载自本仓库 Releases 页面后，点「更多信息」→「仍要运行」即可。

你的 dsh 数据（配置、会话、技能、插件）存放在用户目录的 `.dsh` 文件夹，与官方版通用，搬家或删除程序文件夹都不会动它。卸载 = 删除解压出来的文件夹，仅此而已。

### macOS 怎么拿

用上游自己发布的桌面版。它的 macOS 包由官方流水线产出，签名与 Apple 公证步骤都在流水线里，并且接了自动更新；这两点 actdsh 在合理成本内做不到，所以 2026-09-25 起本仓库不再构建 macOS 包。

官方把桌面版放在自己的 CDN 上，DeepSeek 官网和 dsh 文档页里都没有下载入口（两个页面里 `dsh-desk`、`.dmg` 各命中 0 次），能直接读的是更新通道：

```
https://download.deepseek.com/dsh-desk/feeds/mac-arm64/nightly-mac.yml
```

2026-09-26 从这份通道读到的是 `0.1.7-rc.2`，对应 `.../dsh-desk/bin/mac-arm64/deepseek-harness-0.1.7-rc.2-mac-arm64.dmg`（368481123 字节，另有同版本 `.zip` 供自动更新使用）。想知道官方发到哪个版本，读通道比读版本号可靠。

两点要说清楚：

- **Intel Mac 目前没有官方桌面包。** 官方代码里 `mac-x64` 是受支持的目标，但对应通道返回 404。本仓库的 macOS 构建也已停止，所以 Intel Mac 用户暂时两条路都没有，只能用命令行版。
- 本仓库 `dsh-v0.1.7-rc.2` 及更早的 Release 里，macOS 的 dmg 仍然可以下载和使用，只是不会再随上游更新。

## 与官方桌面版的区别

上游 `apps/desktop` 是一条完整的桌面版流水线：`pnpm dev:desktop` 在本地拉起 Electron，`pnpm package:desktop:win:x64` 与 `package:desktop:mac:arm64` 出包，产物上传到腾讯云 COS，公开可读的地址是 `download.deepseek.com/dsh-desk/`。Windows 出 NSIS 安装器，macOS 出 dmg 与 zip，两个平台都接了 electron-updater，Windows 安装器另开了差量更新。官方桌面版在 GitHub 上看不见：上游 `dsh-v0.1.7-rc.1`、`rc.2`、`alpha.2` 三个 Release 的 assets 都是 0 个，官网与文档页也没有下载链接，分发只走那条 CDN 通道。

actdsh 不改 dsh 本体，它从 npm 上的官方 `@deepseek-ai/dsh` 取同版本包，自己组装 Electron 壳，发布到 GitHub Releases，目前只发 Windows。

| | 官方桌面版 | actdsh |
| --- | --- | --- |
| Windows 形态 | NSIS 安装器，装进用户目录、不提权，安装界面含中英双语 | 免安装 zip，解压到任意位置（含 U 盘）即用，不写注册表 |
| macOS 形态 | Apple 芯片 dmg 与 zip；Intel Mac 的通道存在但返回 404 | 不提供 |
| 自动更新 | 有，走 nightly 通道；Windows 支持差量更新 | 无，到 Releases 下载新版覆盖 |
| 下载渠道 | `download.deepseek.com` CDN | GitHub Releases |
| 版本 | 截至 2026-09-26 为 `0.1.7-rc.2`，滚动预发布线 | 与上游同版本号，每日轮询上游 tag 后跟进 |
| 构建版本清单 | 未提供 | 每次发布附 `upstream-versions-windows-x64.json`，列出这一版实际锁定的全部 dsh 家族包版本（同版本线 270 余个 + 独立版本线若干个） |

自动更新和 macOS 免手动放行只有官方版做得到，所以 macOS 用户应当直接用官方版。actdsh 剩下的是两件官方没有的东西：一个不写注册表、可以放在任意目录的 Windows 绿色包，以及一份说明「这个安装包实际装了哪些依赖、各是什么版本」的构建清单。

## 常见问题

### 使用 actdsh 需要安装 Node.js 或其他环境吗？

不需要。应用内嵌了运行 dsh 所需的全部组件（Node 运行时、Chromium 窗口、插件管理用的 pnpm），装好即用。

### 插件怎么安装？

与官方方式完全一致：dsh 的插件管理基于 pnpm，actdsh 已把 pnpm 内置进安装包并自动接好，插件的安装、更新、卸载都不需要额外准备环境。

### 配置、会话、技能数据存在哪里？

与官方版完全相同，存放在系统用户目录下的 `.dsh` 目录（Windows：`C:\Users\<用户名>\.dsh`；macOS：`~/.dsh`）。如果你之前用过官方命令行版，actdsh 会直接沿用这些数据。

### 端口被其他程序占用会怎样？

dsh 默认使用 3080 端口。actdsh 启动时会自动检测：3080 被占用就依次尝试 3081–3099，都被占则由系统分配空闲端口。即使本机已有另一个 dsh 实例在运行，也不影响 actdsh 正常启动。

### 第一次启动为什么比较慢？

首次进入界面前，dsh 要初始化配置目录（约 1 分钟），窗口会显示启动页并在就绪后自动进入界面。第二次起通常十几秒内即可打开。

### 如何更新到新版本？

actdsh 的版本号与上游完全一致（例如上游发布 `dsh-v0.1.0-rc.8`，本仓库即发布同名版本）。上游发布新版本后，本仓库通常 1 天内自动跟进。到 Releases 页面下载新版覆盖即可，数据不受影响。应用内暂无自动更新。

### 为什么安装包没有做代码签名？

正规的 Windows 代码签名需要付费证书，本项目是零成本的自动化分发，没有购买。首次运行时 SmartScreen 提示「Windows 已保护你的电脑」，确认下载来源后点「更多信息」→「仍要运行」放行一次即可。构建过程全部在 GitHub Actions 公开日志中可查，workflow 文件开源可审。后续可能引入正式签名。

## 工作原理（面向开发者）

```
每日 03:23 UTC 定时轮询
  → 对比「上游最新 dsh-v* 标签」与「本仓库已发布标签」（几秒即退，不消耗构建资源）
  → 发现新版本才启动构建，只有一台 Windows runner
  → 从 npm 安装官方 @deepseek-ai/dsh 对应版本，把同版本线的 @deepseek-ai/* 全部钉到 tag 精确版本，组装 Electron 壳
  → 用户视角自动化验证：真实启动安装包 → 等待 dsh 就绪 → 访问 Web 界面 → 校验 pnpm 垫片可用
  → 验证通过才创建 Release
```

每次发布前，安装包都会在干净的 runner 上被真实启动并通过上述验证。验证不过，版本不会发布。

另有两条每日探针，都与发布路径解耦、失败不阻塞发布：一条打 npm registry，预检版本线钉死会不会因为上游发版而失败；一条读官方桌面版的更新通道，核对它声明的产物是否真能取回、字节数是否与声明一致。

图标与 dsh Web 界面同源（取自上游 favicon）。整个流程只使用 GitHub Actions 与 GitHub Releases，不依赖任何外部服务。

## English Summary

actdsh distributes a ready-to-use, installer-free Windows build of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). No Node.js, npm or any other toolchain is required: the zip bundles the runtime, the official web UI, and pnpm for plugin management, and it reads and writes the same `~/.dsh` directory as the official CLI. Upstream has shipped its own desktop app since 2026-09-24 — a per-user NSIS installer for Windows, a notarized dmg/zip for Apple Silicon, both served from `download.deepseek.com` with electron-updater and differential updates on Windows. macOS therefore comes from upstream, not from actdsh, and Intel Mac has no desktop build from either source yet (the official `mac-x64` feed returns 404). What actdsh still adds is a portable Windows zip that writes nothing to the registry, plus a per-release dependency manifest recording the exact version pinned for every dsh family package. A daily workflow polls upstream tags, builds only when there is a new one, launches the package on a clean runner to verify it end to end, and publishes the result. Third-party packaging, not an official deepseek-ai product.

## 许可与声明

- 本仓库的打包脚本与壳代码：MIT。
- dsh 本体：© deepseek-ai，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- actdsh 与 deepseek-ai 无隶属关系，仅为社区分发；dsh 的功能问题请反馈至[上游仓库](https://github.com/deepseek-ai/deepseek-harness/issues)。

最近更新：2026-09-26
