# MEMORY.md

## 项目

- 名称：Proma
- 仓库：`Proma-git`
- 技术栈：Bun workspace、TypeScript、Electron 43、React、Jotai、Vite、Tailwind CSS、Radix UI、Pi Agent Runtime
- 初始化日期：2026-08-18

## 长期约束

- 默认使用中文沟通；代码、命令和变量名使用英文。
- 本地存储优先，使用配置文件与 `JSON`/`JSONL`，不引入本地数据库。
- 渲染进程状态统一使用 Jotai。
- 功能变化涉及文档时，修改 `AGENTS.md` 与 `README.md` 前需获得用户允许。
- 桌面应用版本必须与当前已合入的最新官方 `v*` 标签一致，fork 自有改动不单独递增；提交说明使用中文。
- 凭据只记录存放位置，不记录具体值。

## 架构决策

- Electron IPC 变更必须依次同步：共享类型与通道常量 -> 主进程处理 -> Preload 桥接 -> 渲染进程调用。
- Agent 仅使用 Pi Agent Runtime；主进程通过独立 utility process 与 `agent-runtime-client.ts` 管理每个会话，禁止重新引入 Claude/Codex Agent SDK。
- Pi runtime 与 `sharp` 等 external 依赖由 `sync-runtime-deps.ts` 在打包前同步，桌面构建同时包含自包含的 Proma CLI 与原生辅助模块。
- fork 保留 LAN Bridge 与 `apps/mobile`；开发 Renderer 统一使用 `127.0.0.1:5174`，LAN Bridge 配置与打包版共享。
- 所有桌面安装包入口统一通过 Electron workspace 的 `package:prepare` 构建 Electron、移动端并同步 runtime external 依赖，避免本地与 CI 打包步骤漂移。
- LAN Bridge 配对 PIN 仅在桌面设置界面显示，不注入移动网页、不写日志或明文文件；配对失败按客户端 IP 独立限速。
- fork 桌面安装包使用 `com.bone.proma.app` 作为系统应用标识，与官方版 `com.proma.app` 区分；保留 `Proma` 产品显示名和现有数据目录。
- 桌面版本号只表示当前合入的官方版本；fork 修订通过 Git 提交追踪，不占用额外 patch 版本。
- 开发版与打包版统一使用 `~/.proma` 存储 Skills、模型、渠道、会话等业务数据；仅 Electron 内部 `userData` 保持开发实例隔离。

## 会话记录

- 2026-08-18：首次建立项目记忆文件；创建时仓库 `main` 指向 `d1a131c7`，配置 `origin` 与 `upstream` 两个远端。
- 2026-08-18：官方 `upstream/main` 停留在旧版本，发布进度应以远端 `v*` 标签为准；本次确认最新官方标签为 `v0.17.42`。
- 2026-08-18：将 fork 从 `v0.12.23` 升级到官方 `v0.17.42`，保留 LAN Bridge、移动端、开发环境隔离与独立发布流程；桌面版本与官方保持为 `0.17.42`。
- 2026-08-18：补齐 Pi `sdk_delta` 到 LAN Bridge 的正文、思考与工具事件映射；修复端口热重启丢失 Agent EventBus 订阅的问题。
- 2026-08-18：独立发布流程集中合并 macOS 双架构更新清单，并上传 `latest*.yml` 与 blockmap；自动更新源指向 fork 的 `kuangtao22/Proma`。
- 2026-08-18：将 fork 的 Electron `appId` 改为 `com.bone.proma.app`，避免与官方安装包使用同一系统应用标识。
- 2026-08-18：明确版本同步规则：桌面版本始终与已合入的最新官方标签一致，当前恢复为 `0.17.42`，方便后续按官方版本更新。
- 2026-08-18：用户确认无需隔离开发版业务配置，统一使用 `~/.proma`；不迁移或复制旧 `~/.proma-dev` 数据。
