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
- Electron 正式应用使用官方基线加 Bone 构建号的 SemVer；正式标签、应用版本和更新元数据必须一致，提交说明使用中文。
- 凭据只记录存放位置，不记录具体值。
- 全量测试使用 `bun test --isolate`，避免历史测试中的 `mock.module` 跨文件污染；定向测试仍可直接指定测试文件。

## 架构决策

- Electron IPC 变更必须依次同步：共享类型与通道常量 -> 主进程处理 -> Preload 桥接 -> 渲染进程调用。
- Agent 仅使用 Pi Agent Runtime；主进程通过独立 utility process 与 `agent-runtime-client.ts` 管理每个会话，禁止重新引入 Claude/Codex Agent SDK。
- Agent 自动标题统一复用 Pi ModelRuntime 的模型、渠道、认证、协议和代理解析；标题使用独立无工具、且不主动启用推理的会话，任何非中止失败均回退为首条用户消息，Chat 对话自身仍保留 Provider Adapter 路线。
- Pi runtime 与 `sharp` 等 external 依赖由 `sync-runtime-deps.ts` 在打包前同步，桌面构建同时包含自包含的 Proma CLI 与原生辅助模块。
- fork 保留 LAN Bridge 与 `apps/mobile`；开发 Renderer 统一使用 `127.0.0.1:5174`，LAN Bridge 配置与打包版共享。
- 所有桌面安装包入口统一通过 Electron workspace 的 `package:prepare` 构建 Electron、移动端并同步 runtime external 依赖，避免本地与 CI 打包步骤漂移。
- LAN Bridge 配对 PIN 仅在桌面设置界面显示，不注入移动网页、不写日志或明文文件；配对失败按客户端 IP 独立限速。
- fork 桌面安装包使用 `com.bone.proma.app` 作为系统应用标识，与官方版 `com.proma.app` 区分；保留 `Proma` 产品显示名和现有数据目录。
- 桌面版本前三段表示当前合入的官方版本，`bone.<构建号>` 表示 fork 发布修订；同一官方版本递增 Bone 构建号，合入新官方版本后重置为 1。
- 开发版与打包版统一使用 `~/.proma` 存储 Skills、模型、渠道、会话等业务数据；仅 Electron 内部 `userData` 保持开发实例隔离。
- 正式版身份固定为 `Proma` / `com.bone.proma.app`，直接启动的开发版固定显示为 `Proma Dev` / `com.bone.proma.dev`；两者隔离 Electron `userData` 和单实例锁，继续共享 `~/.proma` 业务配置。开发版在 Electron `ready` 前固定使用 `@proma/electron` Safe Storage 身份，禁止把展示名直接用于加密身份。
- 从纯 `0.17.42` 迁移到 `0.17.42-bone.5` 需要手动安装一次；后续 Bone 版本使用预发布 SemVer 正常递增更新，不开启全局降级。
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
- 路径管理采用固定 `~/.proma-location.json` 定位文件与重启迁移模式：业务模块继续通过 `getConfigDir()` 解析当前数据根，复制、校验和 Proma-owned 绝对路径重写全部成功后才切换；项目文件迁移独立使用工作区锁，源目录始终保留。
- 数据根迁移计划在正常进程中记录的容量只作为预检值；隔离迁移进程可为 `pending/failed`、零进度且无复制 sidecar 的计划重建最终容量基线，兼容退出流程写入。已有复制进度或 sidecar 的断点继续严格拒绝源容量变化。
- Bone 发布说明以 `release-notes/bone/v<version>.md` 为唯一事实来源；发布前必须校验对应文件存在且非空，GitHub Release 正文与关于页“Proma 修改”历史共同使用该内容。
- macOS 发布优先使用 Developer ID Application 签名与 Apple 公证；证书未配置时允许发布明确标注的未签名 Bone 产物，并在 Release 说明中提供 `xattr` 解除隔离命令。GitHub Actions 不得在 step 自身的 `if` 中读取仅由该 step `env` 注入的证书变量，须先以独立步骤输出签名能力状态。
- 项目文件迁移复用 verified copier，并以活动数据根内的可恢复 journal 驱动 `会话路径 -> 工作区配置 -> projectRootPath` 三步幂等提交；复制、校验和提交失败均不删除源目录。
- 项目迁移准入同时覆盖 Agent in-flight generation、自动标题等 generation-owned 写入、Automation、active/linked worktree 与受守卫 IPC；旧 Agent 代际通过唯一 query token 精确关闭，不会误停同会话的新运行。
- 项目目录选择使用按窗口、用途和代次隔离的一次性 `selectionId`；重启遗留的 copying/verifying/failed journal 只能按已持久化 operation 继续或显式放弃，renderer 不可直接指定任意目标路径。

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
- 2026-08-19：确认整理发布版本与开发/正式身份；下一版本采用 `0.17.42-bone.5`，正式版保持 `Proma`，开发版固定显示为 `Proma Dev`。
- 2026-08-19：完成 `0.17.42-bone.5` 版本体系：应用版本、标签、Release 标题、关于页、更新频道和三平台产物命名统一；GitHub Actions 在四平台构建前校验标签合同，并只在全部构建成功后发布。
- 2026-08-19：Bun 1.3.14 的 `bun install --lockfile-only` 不会自动刷新 workspace 自身的 `version` 字段；修改应用版本后必须显式检查 `bun.lock` 中 `apps/electron.version` 是否同步。
- 2026-08-20：确认文件路径管理设计：全局数据根与单项目路径作为两个独立功能；采用复制、SHA-256 校验、原子切换和保留旧目录策略，移动盘/NAS 离线时禁止静默回退。
- 2026-08-20：完成路径管理的两阶段实施计划；先交付数据根定位、迁移与离线恢复，再复用校验组件交付项目路径迁移、工作区锁和中断恢复。
- 2026-08-22：补齐已发布 Bone 版本和 `0.17.55-bone.1` 的中文更新说明；Release 工作流改为读取仓库内说明文件，并在任务重跑时同步更新已有 Release 正文。
- 2026-08-22：完成项目文件路径管理与迁移：支持外部/托管/离线项目、复制校验、崩溃恢复、取消/继续/放弃、watcher 切换和桌面设置页；发布版本递增为 `0.17.42-bone.6`。
- 2026-08-22：将直接启动的开发客户端名称从 `Proma Dev` 统一为 `PromaDev`；正式客户端仍为 `Proma`，开发/正式 App ID 与 Electron 内部数据隔离规则保持不变。
- 2026-08-22：确认历史共享凭据由 `@proma/electron Safe Storage` 加密，`PromaDev` 与 `Proma Dev` 钥匙串均无法解密；开发客户端现于 `ready` 前使用历史加密身份，之后恢复显示名 `Proma Dev`。
- 2026-08-22：Windows 用户目录可能在定位文件已原子提交后，对目录 `open` 返回 `EACCES`，或对目录 `fsync` 返回 `EPERM/EACCES`；`safe-file` 仅将这些目录能力错误降级为 `file-only` durability，`EIO` 等真实 I/O 故障继续向上传播。
- 2026-08-22：合并官方最新正式版 `v0.17.55`，应用版本重置为 `0.17.55-bone.1`；保留 LAN、路径迁移守卫、Agent generation 隔离与历史 Safe Storage 身份，并将 Pi utility 的 abort/force-close/finally 统一到单一 runtime 关闭 Promise。
- 2026-08-22：关于/更新页将版本历史拆为 `Proma 修改` 与 `官方版本` 两个懒加载标签；历史查询固定映射 Bone/官方仓库并按来源隔离缓存，Electron Updater、最新版本和按标签查询仍只使用 `kuangtao22/Proma`。
- 2026-08-22：`v0.17.55-bone.1` GitHub Actions 全平台发布成功，并回填 `bone.1`、`bone.4`、`bone.5` 中文 Release 正文；若根目录类型检查异常解析到 `apps/electron/node_modules` 的旧 `@types/node`，说明是历史嵌套依赖遮蔽，`bun install --frozen-lockfile` 不会自动清理该目录。
- 2026-08-22：整理 fork GitHub Releases，仅保留当前正式版 `v0.17.55-bone.1` 与上一稳定版 `v0.17.42-bone.5`；删除旧 `0.9.x`、重复草稿及已淘汰 Bone Release，但保留 Git 标签用于历史代码定位。
- 2026-08-22：本机 `gh auth status` 中账号令牌失效时，Git HTTPS 仍可通过系统 Git 凭据直接推送 `kuangtao22/Proma`；排查推送权限时应分别验证 `gh` 与 Git 凭据，不把前者状态当作后者结论。
- 2026-08-22：用户确认 macOS 缺少签名证书时仍需发布，并允许通过 `xattr` 命令解除隔离安装；发布说明必须明确未签名风险，工作流有证书时签名、无证书时显式生成未签名包。
- 2026-08-22：修复 Windows 数据根迁移在计划创建后被退出流程更新 `.proma` 时无法继续的问题；零进度计划在隔离进程中安全刷新容量基线，旧版本已记录为 failed 的同类计划也可直接恢复。
- 2026-08-22：发布 `v0.17.55-bone.4`，macOS arm64/x64、Windows x64、Linux AppImage/deb 与自动更新元数据共 15 个资产均由 GitHub Actions 成功生成；macOS 云端未配置签名证书，Release 正文已提供 `xattr` 解除隔离命令。
- 2026-08-22：评估 `Xiangyu-CAS/codex-canvas` 后确认可将无限画布、JSON 状态模型和图片处理能力移植到 Proma；正式集成必须改用 React/Jotai、Proma 四层 IPC、`safe-file` 与 Pi Agent runtime，禁止原样引入其 Codex CLI/app-server、独立 MCP/HTTP 服务及 `~/.codex/generated_images` 扫描链路。
- 2026-08-22：用户确认 Proma「设计」采用方案 A：每个项目一个原生画布，通过顶部 `设计 · 项目名` 标签在会话与画布间切换，左侧继续只承载项目/会话；正式素材随项目保存到 `.proma/design/`，缓存放 `~/.proma/design-cache/`，首版聚焦画布、批注、Pi 图片任务、版本关系和会话传递。
- 2026-08-22：项目级设计工作区实施计划确定使用 `@xyflow/react@12.11.3`、revision mutation、目录级 `proma-file` 媒体授权和可见 Pi Agent Design Job；Design Job 仅允许 Nano Banana 图片工具，实施按 12 个 TDD 任务推进。
- 2026-08-23：设计工作区的撤销/重做历史按权威文档基线失效：普通 remount 加载相同 revision 与相同 document 时保留；revision 或内容变化、恢复快照及冲突 rebase 时清空。
- 2026-08-23：设计保存冲突仅允许整批 `set-viewport`/`move-nodes` 自动 rebase；批次含任一结构 mutation 时采用远端基线、保留 pending 与失败阻断态，禁止自动或重试覆盖。job 节点首版只允许选择和移动，复制、删除、分组、取消分组及不安全历史在 reducer、Jotai action、键盘和工具栏统一拒绝；主进程 `SAVE_MUTATIONS` 在 workspace write guard 内基于权威文档保护 job 所有权并保留 recovery-required 语义。结构冲突可通过“采用远端版本”清理本地冲突队列，后续编辑按远端 revision 保存。
