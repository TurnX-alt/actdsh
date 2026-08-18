# actdsh

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的**桌面版自动打包仓库**。本仓库通过 GitHub Actions 每日自动巡检上游 Releases，一旦上游发布新的 `dsh-v*` 版本，即自动打包 **Windows（x64）** 与 **macOS（Apple Silicon）** 桌面版，并在本仓库 Releases 以**同名 tag** 同步发布。

> 本项目为第三方打包分发，非 deepseek-ai 官方产品。dsh 本体版权归 deepseek-ai 所有，遵循其 [MIT 许可证](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。

## 下载

前往 [Releases](../../releases) 页面，下载与你系统对应的最新产物：

| 系统 | 文件 | 形态 |
|------|------|------|
| Windows 10/11（x64） | `actdsh-win-x64-<版本>.exe` | 便携版，双击即运行，不写注册表 |
| macOS（Apple Silicon） | `actdsh-mac-arm64-<版本>.dmg` | 拖入"应用程序"即完成安装 |

## 首次运行（重要：未签名说明）

本项目的桌面包**未做代码签名**（见下方"常见问题"），首次运行需放行：

- **Windows**：双击 exe 后若出现"Windows 已保护你的电脑"（SmartScreen），点击 **"更多信息" → "仍要运行"**。
- **macOS**：首次打开若提示"无法验证开发者"，请 **右键（或按住 Control 点按）应用图标 → 打开**，在弹窗中再点 **"打开"**。此后可正常双击启动。

## 使用说明

1. 启动应用后，窗口会显示"正在启动 dsh 服务…"，数秒后自动进入 DSH 图形界面（与 `dsh web` 完全相同）。
2. 窗口关闭即停止后台 dsh 服务并退出。
3. 桌面版包含 dsh 的**全部原生功能**；如需命令行，可进入应用安装目录，在 `resources/dsh/` 中找到完整 `dsh` CLI 使用。
4. 插件管理与官方一致（`dsh plugin`）：包内已内置 pnpm 并自动注入，**无需自行安装** Node.js / npm / pnpm。
5. 你的配置、会话记录、技能与插件全部保存在官方默认目录 `~/.dsh`（Windows：`C:\Users\<你>\.dsh`；macOS：`~/.dsh`），与官方版完全通用。

## 零环境依赖

桌面版面向"官方方案启动失败/没有开发环境"的用户：**不需要**预先安装 Node.js、npm、pnpm 或特定浏览器——

- 应用内嵌 Node 运行时（复用 Electron 内嵌 Node）与 Chromium 窗口；
- 端口自动回退：默认 3080 被占用时自动尝试 3081–3099，仍被占则自动分配空闲端口，与官方版可并存运行；
- 插件安装所需的 pnpm 已随包内置。

## 更新机制

- 上游每发布一个新版本，本仓库**至多约 1 天内**会自动发布同名版本（例如上游 `dsh-v0.1.0-rc.7` → 本仓库 `dsh-v0.1.0-rc.7`）。
- 应用内暂无自动更新；请前往 Releases 下载新版覆盖即可。
- 版本号与上游严格一一对应，Windows 与 macOS 产物永远同步发布。

## 工作原理（面向开发者）

每日 cron（23 3 * * *）
→ poll job（ubuntu，约 10 秒，不 checkout，仅 2 次 API 调用）
   比对「上游最新 dsh-v* tag」与「本仓库已发布 tag」；无变化立即退出
→ build 矩阵（windows-latest + macos-latest 并行，仅新版本触发）
   npm 安装上游 @deepseek-ai/dsh@<版本> → 冒烟验证 → electron-builder 打包
→ release job（两个平台全部成功才执行）
   以同名 tag 创建单个 release，一次挂齐双平台产物（prerelease 标志镜像上游）

- 零外部服务、零外部状态：仅以 GitHub Actions + GitHub Releases 完成全部订阅与分发。
- 公共仓库标准 runner 免费；轮询 job 空转仅约 10 秒。

## 常见问题

**为什么不签名？**
代码签名需要付费证书与 Apple Developer 账号。本项目为零成本自动分发，首版不签名；放行步骤见上文。后续可能引入签名。

**杀毒软件/系统提示风险？**
产物由 GitHub Actions 从公开源码与 npm 官方包自动构建，构建日志全程公开可查（Actions 页面）。如有顾虑可自行审查 workflow：`.github/workflows/release-desktop.yml`。

**端口冲突？**
无需处理：应用会自动回退到空闲端口（3081–3099 或系统分配），与已运行的官方版实例互不干扰。

**首次启动很慢？**
属正常现象：便携版需自解压约 100MB 且 dsh 首次运行要初始化 profile（实测约 2-4 分钟，安全软件扫描会进一步拖慢）。窗口会持续显示启动页，请勿反复双击（应用有单实例保护）。第二次起明显更快。

**启动失败怎么办？**
应用会弹窗提示，并将 dsh 日志写入用户数据目录（Windows：`%APPDATA%\actdsh\dsh.log`；macOS：`~/Library/Application Support/actdsh/dsh.log`），反馈问题时请附上该文件。

**支持 Linux / Intel Mac / Windows arm64 吗？**
暂不支持，后续视需求扩展。

## 许可

- 本仓库的打包脚本与壳代码：MIT。
- dsh 本体：© deepseek-ai，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
