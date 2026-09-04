# 运维模块真实 SSH 登录设计

日期：2026-09-04

## 结论

本阶段交付真实 SSH 登录纵向链路：密码、私钥和 SSH Agent 三种认证，首次 Host Key 指纹确认，Host Key 变化强制阻断，连接/断开状态，以及可交互的远程 PTY 终端。数据库、Redis、Docker、日志和文件页继续复用该连接基础，但不在本阶段返回伪造数据。

SSH I/O 使用独立 Electron utility process 和 `ssh2@1.17.0`。Renderer 只持有公开连接状态和用户正在编辑的临时表单值；主进程持有凭据内存与 `safeStorage` 加密文件；utility process 只在一次连接生命周期内接触解密后的秘密。

## 用户流程

1. 用户新增或编辑服务器，选择密码、私钥或 SSH Agent。
2. 密码默认仅用于本次应用生命周期；勾选“记住密码”后才使用 Electron `safeStorage` 加密持久化。
3. 私钥内容由主进程读取，Renderer 不读取文件内容；私钥路径与 passphrase 不进入 `hosts.json`。
4. 第一次连接先停止在 Host Key 确认态，展示算法与 SHA-256 指纹。用户确认后关闭探测连接，再用 fresh host、fresh credential 和 fresh trust 重新连接。
5. 已固定 Host Key 发生变化时直接阻断，不提供“仍然连接”。用户后续必须通过独立替换固定指纹流程处理。
6. 认证成功后打开远程 PTY；输入、resize、输出和退出通过独立 IPC 事件传输。

## 数据边界

`~/.proma/server-ops/hosts.json` 只保存公开资产：名称、地址、端口、用户名、认证方式、`credentialRef`、标签和时间戳。旧记录中的 `keyPath` 在加载时迁移到凭据存储；迁移无法安全完成时保留主机但标记需要重新选择私钥，不把路径继续返回 Renderer。

`~/.proma/server-ops/credentials.json` 只保存版本化的 safeStorage 密文。密码、私钥路径、私钥内容和 passphrase 不出现在公开 DTO、日志、审计、Renderer atom 或错误消息。Linux 上 `safeStorage` 不可用或 backend 为 `basic_text` 时，记住凭据操作 fail closed；本次内存密码仍可用于连接。

`~/.proma/server-ops/known-hosts.json` 保存 endpoint identity、Host Key 算法、SHA-256 指纹和确认时间。该文件不含秘密，使用 `safe-file` 原子写入。

## 运行时边界

新增 `server-ops-runtime.cjs`，由一个 `ServerOpsRuntimeClient` 管理。连接使用 `hostId + connectionId` 归属，单主机首版只允许一个活跃连接和一个 PTY。运行时协议包含 connect、disconnect、confirm 后重连、PTY input、resize、ACK 和 shutdown。

Host Key verifier 只计算候选指纹，不在 utility process 内决定信任。unknown 返回候选并主动结束 socket；trusted 仅在算法和指纹精确匹配时进入认证；changed 返回旧/新公开指纹并阻断。

终端输出以 16ms 合批、单连接最多 1 MiB 待发送，并要求 Renderer ACK。ACK 前不发送下一批；超限丢弃并插入公开截断提示。断开、runtime 崩溃和窗口销毁都会释放 SSH client、channel、timer 和待处理请求。

## IPC 与 UI

共享合同新增连接、信任和 PTY DTO/事件。主进程 registrar 继续是唯一授权边界，所有调用只允许当前主窗口。Preload 暴露窄方法，不提供读取凭据的方法。

运维标题区增加“连接/断开”按钮和状态；未连接时点击连接打开认证表单。首次指纹使用 AlertDialog；变化指纹使用阻断式 AlertDialog，仅展示原因和关闭操作。终端页使用现有 xterm 视觉和行为，但不复用本地 Terminal 的 session ownership。

## 关联影响

- Agent、Canvas、本地 Terminal DTO 和会话元数据不变。
- `apps/electron/package.json` 增加精确 `ssh2@1.17.0` 与类型依赖。
- main、utility runtime 构建与 runtime dependency sync 增加 SSH runtime 接缝。
- 主机旧 schema 需要兼容迁移；任何迁移失败不得丢失主机资产。
- 应用退出增加幂等 SSH runtime 清理。

## 性能与资源

无连接时只保留少量 Jotai 和 Store 状态，不启动 SSH runtime。首次连接才启动单个 utility process；多个后续连接共享该进程。每个连接最多一个 SSH socket 和一个 PTY channel，输出缓存有 1 MiB 硬上限。UI 不做后台轮询。

## 依赖审查

- `ssh2@1.17.0`：MIT；Node `>=10.16.0`；仓库未归档，最近 push 为 2026-08-20；GitHub 公开 security advisories 为空。
- 功能覆盖密码、私钥、Host verifier、PTY、SFTP，以及 Unix socket、Windows pipe/Pageant SSH Agent。
- 运行时依赖为 `asn1`、`bcrypt-pbkdf`，可选依赖为 `cpu-features` 与 `nan`。
- Proma 不同步可选原生依赖，构建后递归扫描 SSH runtime 依赖闭包不得出现 `.node`。
- TypeScript 使用 `@types/ssh2@1.15.6`，仅作为开发依赖。

## 验收条件

- 三种认证均能建立真实 SSH 连接并打开 PTY。
- unknown Host Key 必须先确认再重连；changed Host Key 必须阻断。
- 记住密码在不安全 safeStorage backend 上失败且不落明文。
- 任何公开 JSON、DTO、日志和测试快照不含密码、passphrase、私钥内容或私钥路径。
- 连接、输入、resize、ACK、断开、runtime 崩溃和退出清理有 BDD 测试。
- 定向测试、`bun run typecheck`、`bun run electron:build` 通过；runtime dependency closure 无 `.node`。
