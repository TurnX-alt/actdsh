# actdsh — 可独立核对的发行链路

**任何人无需信任维护者本人，即可独立核对 actdsh 每一版发行链路的三类证据：官方通道可达性与版本漂移、官方产物 sha512 门禁、钉死依赖构建清单。**

**[打开独立校验面板](https://turnx-alt.github.io/actdsh/)** · [仓库](https://github.com/TurnX-alt/actdsh) · [下载](https://github.com/TurnX-alt/actdsh/releases)

actdsh 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（简称 dsh）的第三方 Windows 便携分发。官方桌面版只经自家 CDN 分发、GitHub Release 不挂安装包，通道声明的 sha512 此前没有第三方核对过。本仓库把这条发行链路的证据摆成公开可核对的视图：面板上的每一项都能落到具体的发布 run、产物哈希与依赖清单，读者自行判断某个产物是否可信、是否落后上游，而不必信任任何单一环节。

- 上游官方仓库：[deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 本项目性质：第三方打包分发，非 deepseek-ai 官方产品；dsh 的功能问题请反馈到上游（见文末声明）
- macOS 请用官方版：上游自 2026-09-24 起发布带自动更新的桌面版，本仓库不再产出 macOS 包

## <img src="assets/icons/shield-check-light.svg#gh-light-mode-only" alt="" width="16" height="16" /><img src="assets/icons/shield-check-dark.svg#gh-dark-mode-only" alt="" width="16" height="16" /> 面板里能核对什么

三类证据，都不需要信任维护者本人：

| 证据 | 你能核对什么 |
| --- | --- |
| 官方通道可达性与版本漂移 | 每条官方分发通道的当前版本、发布 run、发布时间，以及相对上游落后几版；落后通道以颜色 + 落后版本数文字双重标示 |
| 官方产物 sha512 门禁 | 最近一次门禁的具体 run、sha512 前缀与可点的产物链接；门禁对官方分发字节做 sha512 校验，失败即中止打包 |
| 钉死依赖构建清单 | 这一版实际锁定的依赖数与独立补充依赖的逐条版本，可与真实安装树对账 |

面板为静态单页，数据取自每日探针与构建记录的真实快照，逐项可核对到具体的发布 run 与产物哈希。所有状态与动作语义用图标 + 文字双重表达，不单独靠颜色承载。

## <img src="assets/icons/circle-help-light.svg#gh-light-mode-only" alt="" width="16" height="16" /><img src="assets/icons/circle-help-dark.svg#gh-dark-mode-only" alt="" width="16" height="16" /> 数据与边界

- 面板是**带观测时间的快照视图**，不是实时仪表盘；数据刷新依赖重新构建发布，页面上标明观测时刻。
- 这**不等于可复现构建的证明**：字节级可复现需要固定工具链与构建环境逐位一致。本仓库保证的是依赖版本被钉死、产物被真实启动验证、官方产物被第三方核对。
- 面板为独立校验视图，不代表官方立场；所列证据均可由任何人独立核对。

## <img src="assets/icons/download-light.svg#gh-light-mode-only" alt="" width="16" height="16" /><img src="assets/icons/download-dark.svg#gh-dark-mode-only" alt="" width="16" height="16" /> 下载 Windows 免安装包

到 [Releases 页面](https://github.com/TurnX-alt/actdsh/releases) 下载 `actdsh-win-x64-<版本>.zip`：解压到任意位置（含 U 盘），双击 actdsh.exe 即用，不写注册表、不需要 Node.js 或 npm。配置、会话、技能、插件数据与官方版共用用户目录的 `.dsh` 文件夹（Windows：`%USERPROFILE%\.dsh`）。

首次运行若遇 SmartScreen 提示，是因为未购买商业代码签名证书；确认下载自本仓库 Releases 后点「更多信息」→「仍要运行」即可。macOS 请用官方桌面版。

## <img src="assets/icons/scale-light.svg#gh-light-mode-only" alt="" width="16" height="16" /><img src="assets/icons/scale-dark.svg#gh-dark-mode-only" alt="" width="16" height="16" /> 许可与声明

- 本仓库的打包脚本与壳代码：[MIT](./LICENSE)。
- 文档图标：功能 glyph 取自 [lucide](https://lucide.dev)（ISC 许可）经 iconify；平台品牌标（Microsoft / Apple）取自 [LobeHub Icons](https://lobehub.com/icons)（MIT）。浅色/深色双主题变体由本仓库派生。图标仅作文档语义标识，不代表品牌背书；可下载不等于授权，相关商标归各自所有者。
- dsh 本体：© deepseek-ai，[MIT](https://github.com/deepseek-ai/deepseek-harness/blob/master/LICENSE)。
- actdsh 与 deepseek-ai 无隶属关系，仅为社区分发；dsh 的功能问题请反馈至[上游仓库](https://github.com/deepseek-ai/deepseek-harness/issues)。

## English Summary

actdsh is a third-party Windows portable distribution of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh). Its public face is an **independent verification panel**: anyone can check the release chain without trusting the maintainer, across three evidence classes — official channel reachability and version drift, a sha512 gate over the official artifact, and a pinned-dependency build manifest. Every item resolves to a concrete publish run, artifact hash or dependency list. The official desktop app ships only via its own CDN with zero GitHub Release assets, so no third party had verified the channel's declared sha512 against the served bytes before actdsh. The panel is a static page built from real probe and build snapshots, each labeled with its observation time; it is not a reproducible-build proof and does not represent the official position. Installer-free Windows zips remain available on Releases; macOS comes from upstream. Third-party packaging, not an official deepseek-ai product.

最近更新：2026-11-13