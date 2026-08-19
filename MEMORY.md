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
- fork 的 LAN、移动端与后续公网能力必须保持为低耦合扩展层；每次合并官方 Proma 新版本后，通过协议契约、适配层和自动化兼容检查确认自有功能不回退，同时继续获得上游新功能与 Bug 修复。
- LAN 扩展固定按版本化协议、Proma Adapter、IPC、Preload 与 UI 分层；官方运行时服务只允许由 Adapter 接入，降低上游模块重构对移动端功能的影响。
- LAN 设备认证由进程级唯一 `AuthService`/`DeviceStore` 管理；一次性 ticket 仅经 URL fragment 和内存传递。移动端长期设备凭证永久有效直至桌面撤销，桌面仅保存其 SHA-256 哈希；访问令牌固定 15 分钟，受设备版本与撤销状态约束，IP 只作审计元数据，不参与身份校验。
- 上游兼容检查每周临时合并最新正式 `v*` 标签后运行协议、接缝、测试、类型和构建验证；Workflow 保持只读，不 push、不创建 PR、不发布。
- LAN Bridge 停启复用进程级 HMAC；可信设备通过长期凭证自动签发新的 15 分钟访问令牌，Bridge 重启或 DHCP/IP 变化不会要求重新配对，重新扫码会轮换该设备的凭证和 Token 版本。
- 客户端必须先完成 `protocol.hello` 协商，业务层只信任 hello 返回的版本和能力；服务端升级主版本但保留旧协议范围时，旧移动端仍可配对。
- Bridge 启动按生命周期代次串行化；未认证连接从建立起严格 15 秒截止、单 IP 最多 3 个、入站消息最多 64 KiB，超限连接立即释放；外部会话 ID 在 Handler、Adapter 和配置路径三层校验。
- 手机端视觉与桌面端共享语义设计语言，但主题映射保留在 `apps/mobile` 内；默认通过 `prefers-color-scheme` 跟随系统明暗，不导入桌面 Renderer CSS，也不扩展 LAN 协议或持久化字段。
- fork 的标签发布工作流覆盖 macOS arm64/x64、Windows x64 与 Linux x64；Linux 同时提供 AppImage 和 deb，并与其他平台产物汇总到同一个 GitHub Release。
- Linux deb 打包依赖 `apps/electron/package.json` 的 `homepage` 元数据；发布合同测试必须覆盖该字段，避免 AppImage 成功但 deb 在 FPM 阶段失败。
- Electron workspace 使用带 scope 的包名，Linux 必须显式配置不含 `/` 的 `artifactName`，否则 deb 默认输出路径会被拆成不存在的子目录。

## 会话记录

- 2026-08-18：首次建立项目记忆文件；创建时仓库 `main` 指向 `d1a131c7`，配置 `origin` 与 `upstream` 两个远端。
- 2026-08-18：官方 `upstream/main` 停留在旧版本，发布进度应以远端 `v*` 标签为准；本次确认最新官方标签为 `v0.17.42`。
- 2026-08-18：将 fork 从 `v0.12.23` 升级到官方 `v0.17.42`，保留 LAN Bridge、移动端、开发环境隔离与独立发布流程；桌面版本与官方保持为 `0.17.42`。
- 2026-08-18：补齐 Pi `sdk_delta` 到 LAN Bridge 的正文、思考与工具事件映射；修复端口热重启丢失 Agent EventBus 订阅的问题。
- 2026-08-18：独立发布流程集中合并 macOS 双架构更新清单，并上传 `latest*.yml` 与 blockmap；自动更新源指向 fork 的 `kuangtao22/Proma`。
- 2026-08-18：将 fork 的 Electron `appId` 改为 `com.bone.proma.app`，避免与官方安装包使用同一系统应用标识。
- 2026-08-18：明确版本同步规则：桌面版本始终与已合入的最新官方标签一致，当前恢复为 `0.17.42`，方便后续按官方版本更新。
- 2026-08-18：用户确认无需隔离开发版业务配置，统一使用 `~/.proma`；不迁移或复制旧 `~/.proma-dev` 数据。
- 2026-08-18：评估 `dsh-pocket` 后确定远程方案方向：可借鉴二维码发现与可选公网隧道，但不采用无应用层鉴权、改写 Host/Origin 绕过上游安全边界的全量反向代理；公网传输仍须保留 Proma 配对认证、设备撤销和限速。
- 2026-08-18：发现 LAN Bridge 心跳检查间隔为 30 秒、无活动超时为 20 秒且先检查后发心跳，空闲客户端可能约 30 秒被断开；后续应配套回归测试修复，并补齐二维码发现、工具审批、附件传输和断线事件重放。
- 2026-08-18：fork 自动更新源已接入 `kuangtao22/Proma`；更新器按 `latest*.yml` 内的应用版本比较，同一官方版本下仅递增 `bone.*` Release 标签不会触发客户端更新，需等待应用版本提升或另行设计独立的 fork 构建版本。
- 2026-08-19：完成 LAN/mobile 上游兼容优化，实现协议与 Adapter 隔离、设备配对和撤销、连接自愈与移动端恢复，并加入每周只读上游兼容验证。
- 2026-08-19：完成 LAN Bridge 安全收口：修复 Token 刷新延期、恢复失效、并发启动泄漏、协议绕过、未认证资源占用和会话路径穿越，并补齐上游前向兼容配对。
- 2026-08-19：将扫码与 PIN 配对升级为可信设备白名单：稳定设备 ID 和长期凭证支持永久自动续签直至桌面撤销；新增 `trusted-device-credentials` 协议能力及上游兼容检查，IP 仅用于最近访问审计。
- 2026-08-19：补齐 GitHub Release 的 Linux x64 构建与发布合同，全平台发包统一由 `v*` 标签触发。
- 2026-08-19：首次 Linux deb 云端构建暴露缺少项目主页元数据，已补充 fork 主页并加入回归测试。
- 2026-08-19：Linux FPM 会把 `@proma/electron` 默认产物名解释为目录路径，已固定为 `Proma-${version}-${arch}.${ext}` 并加入回归测试。
