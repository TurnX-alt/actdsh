# actdsh — DeepSeek Harness 桌面版（Windows / macOS）

actdsh 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的桌面分发仓库。dsh 官方只提供命令行安装方式（需要自备 Node.js 环境），actdsh 则把官方发布版本原样打包成桌面应用：下载、双击、直接使用，不需要安装 Node.js、npm 或任何其他开发环境。应用窗口内就是完整的 dsh 官方 Web 界面，配置、会话、技能、插件数据与官方版完全通用。本仓库的自动化流程每天检查一次上游新版本，Windows 与 macOS 安装包始终与上游同版本、同步发布。

- 上游官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 本项目性质：第三方打包分发，非 deepseek-ai 官方产品（见文末声明）

## 下载与安装

到 [Releases 页面](../../releases) 下载对应系统的最新安装包：

| 系统 | 文件 | 使用方式 |
| --- | --- | --- |
| Windows 10/11（x64） | `actdsh-win-x64-<版本>.zip` | 解压到任意位置，双击 actdsh.exe 即用 |
| macOS（Apple 芯片） | `actdsh-mac-arm64-<版本>.dmg` | 打开 dmg，双击「双击我完成安装.command」 |

### Windows：解压即用，位置你说了算

把 zip 解压到你喜欢的任意位置（桌面、D 盘、U 盘都可以），双击其中的 actdsh.exe 即可使用。没有安装器、不写注册表、不碰系统里已有的任何程序——应用需要的所有组件都在这个文件夹里。

首次运行时，Windows SmartScreen 可能提示「Windows 已保护你的电脑」。这是因为程序未购买商业代码签名证书（见常见问题）。确认你下载自本仓库 Releases 页面后，点「更多信息」→「仍要运行」即可。

你的 dsh 数据（配置、会话、技能、插件）存放在用户目录的 `.dsh` 文件夹，与官方版通用，搬家或删除程序文件夹都不会动它。卸载 = 删除解压出来的文件夹，仅此而已。

### macOS：多一步安全确认

macOS 对从互联网下载、未经过 Apple 公证的应用会阻止打开（可能提示「应用程序已损坏」或「无法验证开发者」）。这是苹果 Gatekeeper 机制的标准行为，不代表安装包有问题。

处理方式（dmg 窗口里也有同样的图文引导）：

1. 把 actdsh 拖入 Applications。
2. **右键点按**窗口下方的「双击我完成安装.command」→ 选「打开」→ 弹窗中再点「打开」。注意：这个脚本首次打开**同样会有安全提示**（它本身也是下载来的可执行文件），按提示确认一次即可，这是最后一次看到该提示。脚本会自动装入应用程序目录、解除隔离标记并启动。
3. 之后从启动台正常打开 actdsh。

如果你更习惯手动处理，也可以在终端执行：

```bash
xattr -dr com.apple.quarantine /Applications/actdsh.app
```

解除一次即可，之后正常从启动台打开。

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

正规的代码签名需要付费证书（Apple 开发者账号 $99/年及 Windows 代码签名证书）。本项目是零成本的自动化分发，首要不签名、用上文说明的方式放行；构建过程全部在 GitHub Actions 公开日志中可查，workflow 文件开源可审。后续可能引入正式签名。

## 工作原理（面向开发者）

```
每日 03:23 UTC 定时轮询
  → 对比「上游最新 dsh-v* 标签」与「本仓库已发布标签」（几秒即退，不消耗构建资源）
  → 发现新版本才启动构建：Windows 与 macOS 两台 runner 并行
  → 从 npm 安装官方 @deepseek-ai/dsh 对应版本，组装 Electron 壳
  → 用户视角自动化验证：真实启动安装包 → 等待 dsh 就绪 → 访问 Web 界面 → 校验插件链路
  → 双平台全部通过才创建 Release，两份安装包挂同一个标签
```

每次发布前，两个平台的安装包都会在干净的 runner 上被真实启动并通过上述验证——这正是你下载后可以直接使用的底气。验证不过，版本不会发布。

图标与 dsh Web 界面同源（取自上游 favicon）。整个流程只使用 GitHub Actions 与 GitHub Releases，不依赖任何外部服务。

## English Summary

actdsh distributes ready-to-use desktop builds of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh) for Windows (x64, portable zip) and macOS (Apple Silicon, dmg). No Node.js, npm, or any other toolchain is required: the app bundles the runtime, the official web UI, and pnpm for plugin management, and stores data in the same `~/.dsh` directory as the official CLI. A GitHub Actions workflow checks upstream for a new `dsh-v*` tag once a day, builds both platforms in parallel, smoke-tests each package by actually launching it, and publishes both assets under the same tag. Third-party packaging, not an official deepseek-ai product.

## 许可与声明

- 本仓库的打包脚本与壳代码：MIT。
- dsh 本体：© deepseek-ai，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- actdsh 与 deepseek-ai 无隶属关系，仅为社区分发；dsh 的功能问题请反馈至[上游仓库](https://github.com/deepseek-ai/deepseek-harness/issues)。

最近更新：2026-08-21
