# DutyDeck

<img src="./docs/assets/brand/dutydeck-icon-256.png" alt="DutyDeck" width="96" height="96" />

> **本仓库是 Proma 的修改版。** DutyDeck 基于上游开源项目 [Proma](https://github.com/proma-ai/Proma)（AGPL-3.0-only）演进，由 [kuangtao22](https://github.com/kuangtao22) 独立维护，与 Proma 官方没有从属关系，也没有得到官方背书。上游基线与差异说明见[与官方 Proma 的关系](#与官方-proma-的关系)。

DutyDeck 是一个本地优先的 AI 桌面工作台：把多模型 Chat、通用 Agent、画布编排、运维工作台、接口工作台、Skills、MCP 和远程机器人放进同一个客户端，数据和配置默认留在你自己的机器上。

它不是只面向闲聊的聊天框，而是一个能长期沉淀工程工作流的工作台：简单问题用 Chat，复杂任务交给 Agent，服务器和数据库交给运维工作台，接口验证交给接口工作台，编排交给画布。

[下载 DutyDeck](https://github.com/kuangtao22/Proma/releases/latest) | [新手教程](./tutorial/tutorial.md) | [更新日志](./release-notes/bone) | [English README](./README.en.md)

## 现在能做什么

- **画布**（本仓库自研）：把 Agent 任务、素材与依赖画成节点图，按真实层级与关联一键整理，用一张图推进多步骤交付。
- **运维工作台**（本仓库自研）：SSH、MySQL、PostgreSQL、Redis 连接集中管理；默认只读、写操作只生成脚本；运行诊断、表结构浏览、SQL 工作台与查询历史都在本地完成。
- **接口工作台**（本仓库自研）：按集合与环境组织接口，支持变量、集合级鉴权继承、加密与签名、multipart 附件、批量整理，以及由 Agent 批量执行用例并逐条确认。
- **今日活动**（本仓库自研）：跨项目汇总今天的全部会话，按最后一次对话时间排序，含委派子会话与定时任务会话。

以下能力继承自上游 Proma，并在本仓库持续维护：

- **Chat 模式**：多模型对话、附件解析、图片输入、Markdown / Mermaid / KaTeX / 代码高亮、并排对话、系统提示词、上下文管理。
- **Agent 模式**：Agent 内核已全面迁移至 DutyDeck 内置 Pi Agent Runtime，不再依赖第三方 Agent 运行时；支持工作区隔离、权限模式、文件操作、长任务流式输出、计划确认和用户追问。
- **内嵌浏览器自动化**：Agent 可以直接操作内置受管浏览器——打开网页、观察页面结构、点击 / 填写控件、切换标签页，并支持打开 `localhost` 本地开发服务；站内搜索、登录后页面、动态内容和本地 HTML 预览都能交给 Agent 完成，无需手动复制粘贴。
- **协作与任务**：复杂任务可拆分为可追踪的协作子 Agent / Task，并在消息流中展示调用过程和结果。
- **Skills、MCP 与项目指令**：每个 DutyDeck 项目独立配置 Skills 与 MCP Server；项目可通过 `AGENTS.md` 声明受信项目指令，旧 `CLAUDE.md` 配置自动迁移。项目文件可使用用户选择的本地项目根目录，也可使用 DutyDeck 托管的空白项目目录。
- **远程机器人**：支持飞书 / Lark 机器人桥接，并已提供钉钉、微信桥接入口，用手机或群聊触发本机 Agent 工作流。
- **记忆与工具**：Chat 和 Agent 可共享工作区记忆，记忆变更自动追踪并在界面提示刷新；支持联网搜索、内置 Chat 工具、Agent 推荐等辅助能力。
- **本地优先**：会话、工作区、附件、配置、Skills 等默认存储在 `~/.proma/`，使用 JSON / JSONL 文件组织，不依赖本地数据库。
- **桌面体验**：自动更新、代理设置、文件预览、全局快捷键、快速任务窗口、Agent 灵动岛运行状态、语音输入、亮色 / 暗色 / 跟随系统主题。

## 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/kuangtao22/Proma/releases) 下载 DutyDeck，提供 macOS Apple Silicon、macOS Intel、Windows、Ubuntu/Debian x86_64 的 `.deb` 安装包和 Linux x86_64 AppImage，产物名形如 `DutyDeck-<版本>-macos-arm64.dmg`、`DutyDeck-<版本>-windows-x64.exe` 与 `dutydeck_<版本>_amd64.deb`。Linux 的安装、安全边界和支持范围见 [Linux 说明](./docs/linux.md)。

DutyDeck 的模型渠道全部由你自己配置，不提供任何内置订阅通道。上游的商业版 Proma（proma.cool）与本项目无关。

### 与官方 Proma 的关系

DutyDeck 是 Proma 的修改版，不是官方发行版：

- **许可证**：AGPL-3.0-only，与上游一致，完整条款见 [LICENSE](./LICENSE)。
- **上游基线**：已完整合入的上游内容基线是 `v0.19.31`（2026-09-05），其后的官方版本按需挑选移植，因此功能不等同于官方最新版。
- **版本号含义**：`0.19.53-bone.10` 是「上游版本号 + 本仓库构建号」，`-bone.<构建号>` 只标记本仓库自己的发布顺序，不代表官方迭代进度。
- **本仓库新增**：画布、运维工作台、接口工作台、今日活动，以及围绕它们的权限确认、审计与本地加密。
- **归属**：上游代码的版权归 Proma 作者与贡献者所有，本仓库的修改同样以 AGPL-3.0 授权给任何人。

### 首次配置

1. 打开 DutyDeck，先完成环境检查。Agent 模式依赖本机基础环境，尤其是 Git、Node.js / Bun 以及可用的 Shell。
2. 进入 **设置 > 渠道**，添加至少一个 AI 供应商渠道，填写 Base URL、API Key 和模型列表。
3. Chat 模式可以使用 OpenAI、Anthropic、Google 或 OpenAI 兼容协议的渠道。
4. Agent 使用 Pi Runtime，可使用任意已启用的模型渠道。
5. 进入 **设置 > Agent**，选择默认 Agent 渠道、模型和工作区。
6. 如需记忆、联网搜索、飞书 / 钉钉 / 微信桥接，在设置页对应 Tab 中继续配置。

## 模式选择

### Chat 适合

- 日常问答、解释、翻译、润色、轻量代码讨论。
- 读取附件内容后做总结、改写、比较。
- 使用联网搜索或记忆工具增强一次性对话。
- 同时对比多个模型输出，或用不同系统提示词做探索。

### Agent 适合

- 修改、创建、整理本地文件。
- 调研、编写报告、处理多步骤任务。
- 使用 MCP、Skills、Shell、Git、项目文件等外部上下文。
- 需要权限确认、计划模式、后台任务或远程机器人持续跟进的工作。

简单说：**只需要回答时用 Chat，需要行动和交付结果时用 Agent。**

## 截图

### Chat 快速分析

用 Chat 处理轻量但真实的分析任务：整理读者关注点、生成对比表，并把首屏文案快速定稿。

![DutyDeck Chat 快速分析](./docs/assets/screenshots/proma-chat-demo.png)

### Agent 工作台

Agent 在项目根目录与会话工作台中读取文件、推进任务、输出表格化结论，并把可复用文件保留在右侧文件面板中。

![DutyDeck Agent 工作台](./docs/assets/screenshots/proma-agent-demo.png)

### Skills

每个工作区都可以沉淀专属 Skills。截图中的 `feedback-synthesis` 用于把用户反馈、访谈记录和 issue 聚合成主题、证据与优先级建议。

![DutyDeck 工作区 Skills](./docs/assets/screenshots/proma-skills-demo.png)

### Skills & MCP

同一个工作区可以管理 stdio / HTTP MCP Server，按需启用或关闭，让 Agent 在不同项目里获得不同的外部上下文。

![DutyDeck MCP 配置](./docs/assets/screenshots/proma-mcp-demo.png)

### 流式语音输入(支持全局输入)
DutyDeck 支持豆包的流式语音输入功能，并且支持在 DutyDeck 内使用和 DutyDeck 外部使用：
- DutyDeck 内部使用：Ctrl + ` 触发识别，再次按下结束自动输入到 DutyDeck 内对应的输入框
- DutyDeck 外部使用：Ctrl + ` 触发识别，再次按下结束自动输入到当前的光标所在处，如无光标则默认写入到剪贴板
- 
![DutyDeck 语音输入](./docs/assets/screenshots/proma-typeless-input.png)

## Agent 运行时与模型渠道

DutyDeck 的 Agent 模式由 **Pi Agent Runtime** 单一驱动，内核来自 `@earendil-works/pi-coding-agent`、`pi-agent-core` 和 `pi-ai`，不再依赖任何第三方 Agent 运行时。已启用的 DutyDeck 渠道会动态注册为 Pi provider，支持 OpenAI Chat Completions / Responses、Google Generative AI、Anthropic Messages 及其兼容端点。早期基于 Claude runtime 的历史会话保留为只读记录，可查看但不能继续、分叉或回退。

| 渠道类型 | Chat | Pi Agent |
| --- | --- | --- |
| Anthropic / Anthropic 兼容 | 支持 | 支持 |
| DeepSeek、Kimi API / Coding Plan、智谱 Coding Plan、MiniMax、小米 MiMo 等 Anthropic 协议渠道 | 支持 | 支持 |
| OpenAI、OpenAI Responses、Google、智谱 AI、豆包、通义千问 | 支持 | 支持 |
| OpenAI 兼容自定义端点 | 支持 | 支持 |
| ChatGPT 订阅（Codex OAuth） | — | 支持 |
| xAI 订阅（Grok OAuth） | — | 支持 |

## 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Bun |
| 桌面框架 | Electron 39 |
| 前端 | React 18 + TypeScript |
| 状态管理 | Jotai |
| 样式 | Tailwind CSS + Radix UI |
| 富文本输入 | TipTap |
| Markdown / 图表 / 公式 | React Markdown + Beautiful Mermaid + KaTeX |
| 代码高亮 | Shiki |
| 构建 | Vite + esbuild |
| 分发 | electron-builder |
| Agent Runtime | Pi: `@earendil-works/pi-* @0.82.1` |

## 架构概览

DutyDeck 的核心通信路径是：

```text
shared 类型和 IPC 常量
  -> main/ipc.ts 注册处理器
  -> preload/index.ts 暴露 window.electronAPI
  -> renderer Jotai atoms 和 React 组件调用
```

主进程服务集中在 `apps/electron/src/main/lib/`：

- `agent-orchestrator.ts`：Pi Agent 编排、环境变量、事件流、错误处理。
- `adapters/pi-agent-adapter.ts`：Pi 运行时适配与会话管理。
- `agent-session-manager.ts`：Agent 会话索引和 JSONL 消息持久化。
- `agent-workspace-manager.ts`：DutyDeck 工作区、项目根目录、MCP 与 Skills 管理。
- `browser-controller.ts`：内置受管浏览器控制、跨会话视图隔离与本地预览。
- `agent-memory-refresh-service.ts`：工作区记忆变更追踪与刷新。
- `chat-service.ts`：Chat 流式调用、Provider Adapter、工具活动。
- `conversation-manager.ts`：Chat 会话索引和消息存储。
- `channel-manager.ts`：渠道 CRUD、API Key 加密、连接测试、模型获取。
- `feishu-bridge.ts` / `dingtalk-bridge.ts` / `wechat-bridge.ts`：远程机器人桥接。
- `chat-tool-*`、`document-parser.ts`、`workspace-watcher.ts`：工具、文档解析和文件监听。

渲染进程以 Jotai 管理状态，关键 atoms 位于 `apps/electron/src/renderer/atoms/`。Agent IPC 监听器在应用顶层全局挂载，避免切换页面时丢失流式事件、权限请求或后台任务状态。

## 打包注意事项

Pi 运行时在主进程中作为 esbuild external 依赖运行。`apps/electron` 的打包脚本会在 `electron-builder` 前执行 `bun run sync:runtime-deps`，把下列依赖及其运行时闭包复制到应用目录：

- `@earendil-works/pi-coding-agent`、`pi-agent-core`、`pi-ai`
- Pi 运行时所需的原生模块和 `pdfjs-dist`

修改打包配置时，请确认：

- `build:main` / `watch:main` 将 Pi runtime 依赖标记为 external。
- `scripts/sync-runtime-deps.ts` 的 external runtime 清单与实际依赖一致。
- `electron-builder.yml` 保留 Pi native addon 所需的 `asarUnpack` 规则。
- 在目标平台测试 `bun run dist:fast` 后，验证 Pi Agent 可以启动、调用工具和恢复会话。

更完整的工程约定见 [AGENTS.md](./AGENTS.md)。

## 贡献

欢迎修 Bug、补文档、加测试、完善体验，也欢迎围绕真实场景提交新的 Skills、MCP 配置或 Agent 工作流。

提交 PR 前建议先确认：

- 使用 Bun 运行脚本，不混用 npm / pnpm lockfile。
- 状态管理使用 Jotai。
- 尽量保持本地优先，优先使用配置文件和 JSON / JSONL。
- TypeScript 不使用 `any`，对象结构优先使用 `interface`。
- 新增 IPC 时同步修改 shared 类型、main handler、preload bridge 和 renderer 调用。
- 影响包行为时递增对应 package 的 patch 版本。
- 能用测试覆盖的行为尽量补上测试，尤其是共享逻辑、IPC 契约和持久化格式。

## 作者与维护

- 上游 Proma 作者：[erlich.fun](https://erlich.fun)
- DutyDeck 维护者：[kuangtao22](https://github.com/kuangtao22)

## 致谢

- [Shiki](https://shiki.style/)：代码高亮。
- [Beautiful Mermaid](https://github.com/lukilabs/beautiful-mermaid) 与 [Mermaid](https://mermaid.js.org/)：Mermaid 图表渲染与官方兜底渲染。

## 许可证

DutyDeck 采用 [GNU Affero General Public License v3.0（AGPL-3.0-only）](./LICENSE) 开源。本仓库的 `LICENSE` 与上游 Proma 逐字节一致，不附加任何额外限制。

**你可以**：自由使用、修改、分发 DutyDeck 及其衍生作品，也可以商业使用。前提是遵守 AGPL-3.0——以源代码或修改后的形式分发，以及通过网络对外提供服务时，都要公开完整的对应源码，衍生作品必须继续以 AGPL-3.0 授权。

**永久开源承诺**：DutyDeck 的每一个发布版本都以 AGPL-3.0 在公开仓库释出，任意历史版本都能取得对应源码。本仓库不收集、也不接受把贡献重新授权为专有许可的权利——包括维护者在内，没有任何人能把这套代码闭源。

**商业授权豁免**：本项目不提供、也无权提供 AGPL 商业豁免。需要闭源集成请自行遵守 AGPL-3.0，或向拥有版权的上游 Proma 申请其商业许可。

向 DutyDeck 提交 Pull Request 即表示你同意你的贡献以 AGPL-3.0-only 授权给任何人；本项目不要求你转让版权。
