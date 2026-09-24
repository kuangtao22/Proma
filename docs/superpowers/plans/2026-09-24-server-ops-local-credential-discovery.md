# 本机数据源凭据发现（L1）

## 背景

本地调试库的凭据通常不是"用户设过又忘了"的口令，而是脚本随机生成、写在某处或注入到容器环境里的值。用户在运维面板手填凭据时，面对的正是这种"机器知道、人不知道"的密码（现场案例：`127.0.0.1:13307` 是 Podman 容器 `chebenben-local-mysql` 的转发端口，root 口令由 `bin/setup-local-mysql.sh` 用 `openssl rand -hex 24` 生成后写进 `~/.chebenben/mysql/runtime.env`）。

用户已明确只做 **L1（发现凭据）**，不做 L2（Proma 代建只读账号并把口令直接写进 safeStorage）。

## 目标

在数据源弹窗里，对"本机 + 回环地址"的目标提供一次「从本机查找凭据」：Proma 找出该实例上可用的账号与口令，用户点一下就能填入并测试，不再需要自己去终端里挖密码。

## 范围

**本轮做**

1. 回环地址（`127.0.0.1` / `::1` / `localhost`）的 MySQL、PostgreSQL、Redis 数据源，从本机容器运行时发现凭据。
2. 按"发布地址 + 端口"精确匹配容器，读取其环境变量中的账号与口令。
3. 弹窗内的候选列表与一键填入（只写草稿，不保存、不自动测试）。
4. 四层契约（shared / main / preload / renderer）与对应的 BDD 测试。

**本轮不做**

- 不做 L2：不创建账号、不改权限、不自动保存。
- 不读用户目录或项目文件，**不接收手输路径**：本版根本不具备"读任意文件"的能力。
- 不支持非回环地址（见下面的"凭据串库"风险）。
- 不新增运行时依赖；容器运行时用本机已有的 `podman` / `docker` CLI。

## 为什么第一版只做容器环境

- 它精确覆盖当前的痛点形态：本地开发库跑在 Podman/Docker 里，口令在容器环境变量中。
- 它不需要给 Proma 增加任何"读本机文件"的能力，风险面最小、可解释性最好。
- "口令写在项目 `.env` / compose / bin 脚本里"这一类，需要用户显式授权一个目录再搜，单独一版做更干净（见"分期"）。

## 数据流

```
用户填 127.0.0.1 : 13307 → 点「从本机查找凭据」
  → renderer: discoverServerOpsDataCredentials({ address, port, engine })
  → preload: 严格解析输入 → invoke
  → main handler（server-ops-ipc.ts）
  → ServerOpsLocalCredentialDiscovery（新服务，main/lib/server-ops/）
      1. 地址必须是回环，否则返回 unsupported（不复用"私有网段"判据）
      2. 解析容器运行时：podman 优先，其次 docker（走 shell-env 解析出的 PATH）
      3. `ps --format json` 找出发布了 `<address>:<port>` 的容器；host 与 port 都必须精确相等
      4. `inspect --format '{{json .Config.Env}}'` 读取该容器的环境变量
      5. 按引擎映射账号/口令键，产出候选（**不含口令值**）
  → 返回 { candidates: [{ id, label, username, hasPassword, origin }] }
用户点「使用」
  → renderer: applyDiscoveredCredential({ candidateId })
  → main: 用同一份发现结果返回该候选的 username 与 password
  → 填入草稿（提示"来自本机发现，尚未保存"），用户自行测试与保存
```

## 新契约（packages/shared/src/types/server-ops-data.ts）

- 通道：`DISCOVER_SOURCE_CREDENTIALS`、`APPLY_DISCOVERED_CREDENTIAL`
- 导出判据：把现有的私有 `isLoopbackAddress` 提升为 `isServerOpsLoopbackAddress`，主进程与 UI 共用同一判据，避免"界面说能发现、主进程说不行"
- 输入：`{ address: string; port: number; engine: ServerOpsDataEngine }`
- 候选：`{ id: string; label: string; username?: string; hasPassword: boolean; origin: 'container-env' }`，上限 8 条
- 结果：`{ candidates: ServerOpsDataCredentialCandidate[] }`
- 应用输入：`{ candidateId: string }`；结果：`{ username?: string; password: string | null }`
- 解析器：拒绝未知字段；字符串长度上限；口令沿用 `isSecretText`
- 稳定错误码：输入非法、候选不存在/已过期、地址不受支持（非回环）

## 主进程实现要点

- argv 完全固定，不接受任何用户可控的命令参数；容器名只来自 `ps` 的发现结果，使用前按同一份列表复核，杜绝注入。
- 每次调用设超时（5 s）与输出上限（1 MiB）；CLI 失败或输出异常一律只回"未发现"，不把 CLI 原文抛给界面。
- 口令只存在于主进程内存与本次 IPC 回执：不写日志、不写审计、不进 Agent 上下文、不落盘。
- 放在主进程而不是 utility process：这是本机 OS 能力（进程与容器运行时），不是数据库协议能力；主进程已有 `shell-env` 与 `execFile` 封装可复用。
- 不缓存发现结果：候选带一次性的 `id`，弹窗关闭即失效，避免旧口令被复用。

## 界面（ServerOpsDataSourceDialog.tsx）

- 仅在 `transport = direct` 且地址为回环、引擎受支持时，在「登录凭据」区上方显示「从本机查找凭据」入口与一行说明。
- 结果列表每行显示：来源、账号、是否含口令；点「使用」填入用户名与密码。
- 填入后密码框下提示"来自本机发现，保存后由系统钥匙串加密保存"；发现为空或失败时给出明确原因并保留人工输入。
- 关窗即丢弃候选，不引入任何持久化状态。

## 测试计划

- shared 解析器：未知字段、超长字符串、端口越界、候选 id 格式、口令含空字符。
- 主进程：非回环地址直接拒绝；容器匹配必须 host 与 port 都相等（含"同端口不同 host 不得匹配"的反例）；环境变量映射覆盖 MySQL 5.7/8、PostgreSQL、Redis；`podman` 缺失时降级；命令超时与输出超限；容器名注入尝试被拒。
- IPC：新增通道后同步 `server-ops-ipc.test.ts` 的 remove-handler 数量断言（+2）。
- 渲染层：按钮只在回环出现；一键填入用户名与密码且不触发保存；发现为空时保留人工输入。
- 手工验收：用本机 `127.0.0.1:13307`（容器 `chebenben-local-mysql`）走完整流程。

## 影响与风险

- 影响：新增两个 IPC 通道与一个主进程服务；不改动既有 probe/diagnostics/授权链路，不新增常驻进程或轮询。
- 凭据串库：若按端口匹配容器，`172.16.10.198:3306` 这类远程库可能被本机同名端口容器的口令污染。对策是"回环限定 + host:port 精确匹配 + 引擎匹配"三道限制。
- 身份过高：容器环境里给出的是 root 与应用账号，填入后 Proma 以高权限身份连接，数据库层失去第二道门。对策是在候选里标注账号类型（例如"root（可写，不建议）"），并在填入后提示"建议改用只读账号"（只引导，不自动执行）。
- 打包后 PATH 缺失：Electron 应用默认 PATH 可能找不到 `podman`/`docker`，复用 `shell-env` 解析；确有缺失时明确回"未能发现"，不静默失败。
- 性能：仅在用户点击时执行两条本机 CLI 命令，无后台扫描、无常驻开销。

## 分期

- **P1（本轮）**：容器环境发现 + 弹窗入口与候选列表 + 四层契约 + 测试。
- P2：标准位置（`~/.my.cnf`、`~/.pgpass`）与"用户显式授权的项目目录"（compose / `.env` / bin 脚本），仍然只出候选、不自动填入。
- P3（= L2）：一键创建只读账号并把口令直接写进 safeStorage；与"数据库结构与数据修改只走脚本"的现有约束冲突，需要单独开口子（语句白名单、显式确认、写审计、Agent 不可调用）。

## 实现记录（2026-09-24，P1 已完成）

**契约层**：`packages/shared/src/types/server-ops-data.ts` 新增 `DISCOVER_SOURCE_CREDENTIALS` / `APPLY_DISCOVERED_CREDENTIAL` 两个通道、四个类型与四个严格解析器；把原来的私有回环判据提升为 `isServerOpsLoopbackAddress`，界面与主进程共用同一条边界。

**主进程**：新增 `server-ops-local-credential-discovery.ts`（容器运行时探测接口 + podman/docker 输出解析 + 环境变量到候选的映射），由 `ServerOpsDataService` 注入（默认走 CLI，测试注入夹具），并在 `server-ops-ipc.ts` 注册两个 handler。

**preload**：`server-ops-data-preload.ts` 增加两个方法，输入与回执两侧都走严格解析器；渲染层按"旧客户端缺失即隐藏入口"的既有约定处理。

**界面**：数据源弹窗在"本机直连 + 回环地址"时显示「从本机查找凭据」，候选列表展示来源、账号与权限等级（超级用户会提示改用只读账号），点「使用」只填草稿、不保存、不自动测试；地址、端口或引擎变化即作废候选。

**验证**：`bun test --isolate` 覆盖 server-ops 主进程、渲染层、preload 与 shared 共 123 个文件 1464 项，1462 pass / 2 fail（两处为既有的沙箱 fs watcher 超时，与本次改动无关）；`apps/electron` 与 `packages/shared` 类型检查通过；已重建 `dist/main.cjs` 与 `dist/preload.cjs`，开发实例需要重启才会加载新产物。

**本轮未做**：不创建账号（L2）、不读用户文件（P2）、不缓存发现结果、不做协议指纹识别（容器匹配只依据发布地址与端口）。
