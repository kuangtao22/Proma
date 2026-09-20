# 运维模块改为项目制（设计 + 实施计划）

> 状态：实施中（阶段 A 已开工）
> 日期：2026-09-18
> 背景：用户在接入本机/容器数据库时确认「服务器、数据库、Redis 分离部署」是常态，要求侧栏以**项目**为单位组织，项目内自由组合服务器、数据库、Redis，各自独立登录。

## 1. 结论与目标

把运维模块的顶层锚点从「主机（SSH host）」换成「项目」，项目之下是**连接**：SSH 服务器、数据库、Redis（后续可扩展 Kubernetes、对象存储等）。每个连接独立登录，数据库/Redis 自带连接方式（本机直连或经由某条 SSH 连接）。

为什么必须换锚点：现在数据源、审计、Agent 授权全部以 `hostId` 为键，导致「只管理一个数据库」这种最小场景也必须先建一台 SSH 主机——这是当前主要摩擦点，且无法靠加字段绕开。

不做的事：不改 SSH 信任模型（Host Key 仍按 endpoint 固定）、不改文件/终端/Docker 的运行时边界、不引入远端组件。

## 2. 现状与差距

| 关注点 | 现状 | 目标 |
| --- | --- | --- |
| 顶层实体 | `hosts.json` 中的主机（address/port/username/authMethod/tags） | `projects.json` 中的项目；主机成为项目内的连接条目 |
| 数据源归属 | `data-sources.json` 以 `hostId` 为键 | 以 `projectId` 为键，并自带 `transport: 'direct' \| 'ssh'` |
| 连接方式 | 只能经由主机 `forwardOut` | 直连（utility 内直接 TCP/TLS）或经由选定的 SSH 连接 |
| 能力归属 | 终端/文件/Docker/服务/日志/数据服务 都是工作台页签 | 终端/文件/Docker/服务/日志 挂在**选中的 SSH 连接**下；数据库/Redis 是独立连接条目 |
| 审计资源 | `hostId` | `projectId` + 连接身份，旧记录保持兼容 |
| Agent 授权 | `(sessionId, hostId)` | `(sessionId, projectId)` |

已经完成的一步（2026-09-18）：数据源的 `transport`（直连/经跳板）已打通到契约、存储、服务、utility runtime、IPC 与弹窗选择器，生产代码类型检查通过。项目制直接复用这一层，只需再补 `projectId`。

## 3. 目标模型

```
项目（侧栏一级，例如「生产环境」「本地开发」）
├── 连接
│   ├── SSH 服务器      独立登录 ──→ 终端 / 文件 / Docker / 服务 / 日志
│   ├── 数据库          独立登录（本机直连 或 经由项目内某条 SSH）
│   └── Redis           同上
└── 审计（按项目过滤，可下钻到连接）
```

规则：

- 一个项目至少含一个连接；只有一个数据库的项目是合法且常见的形态。
- 数据库/Redis 选择跳板时，默认列出本项目内的 SSH 连接，同时允许选择其它项目的连接（跨环境跳板是真实需求），但要在选项上标注来源项目。
- 文件/终端/Docker/服务/日志 不在连接清单里独立出现：它们属于「某条 SSH 连接上的操作」，UI 上先选连接再看这些页签。

## 4. 数据模型与迁移

| 文件 | 变化 | 迁移 |
| --- | --- | --- |
| `~/.proma/server-ops/projects.json`（新增） | `{ version: 1, projects: [{ id, name, createdAt, updatedAt }] }` | 首次启动若无文件且存在主机，则创建「默认项目」并把现有主机归入 |
| `hosts.json` | 每条主机增加 `projectId` | 读取时缺失 `projectId` 的主机归入默认项目；写回时补全（原子写 + 备份，不丢字段） |
| `data-sources.json` | 增加 `projectId`；`transport`/主机可选 | 现有文件为空，无需迁移；读取层对缺失 `projectId` 的条目归入默认项目 |
| `known-hosts.json` | 不变 | 信任按 endpoint 固定，与项目无关，跨项目共享同一份可信身份 |
| `audit.json` | 新记录带 `projectId`；`hostId` 保留为可选 | 旧记录无 `projectId`，审计页显示为「未归属」，不重写历史 |
| `credentials.json` / `data-source-credentials.json` | 不变（仍按 hostId / sourceId 绑定） | 无需迁移 |

`data-sources.json` 的最终条目形态：

```ts
{
  id, projectId, transport: 'direct' | 'ssh', hostId?,
  engine, label, address, port, database?, username?,
  tlsMode, tlsServerName?, credentialRef?, createdAt, updatedAt
}
```

约束（沿用并强化现有规则）：`transport === 'ssh'` 必须有 `hostId`，`direct` 不得有；直连非回环地址强制 `tlsMode === 'verify'`，否则拒绝发起连接。

## 5. 权限与审计

- **Agent 授权**：组合键从 `(sessionId, hostId)` 改为 `(sessionId, projectId)`，一次授权覆盖项目内所有连接。代价是失去「只授权某个库」的粒度；收益是符合「把这个环境交给 Agent」的直觉。授予/撤销仍由主进程持有权威事实，渲染层只做投影。
- **审计**：`ServerOpsAuditRecord` 增加 `projectId`（可选，兼容历史），资源类型增加 `project`。写入时由服务层从数据源/主机解析 `projectId`，不接受渲染层自报。
- **连接隔离不变**：SSH 连接代次、数据源单飞与并发上限、切项目时丢弃迟到结果，全部沿用现有机制，只是作用域从 `hostId` 换成 `projectId`/连接身份。

## 6. 分阶段实施

**阶段 A：契约与存储（无 UI 变化）**
- [x] 新增 `packages/shared/src/types/server-ops-project.ts`：项目合同、四个 IPC 通道与全部严格 parser。
- [x] 新增 `server-ops-project-store.ts`：原子写 + schema 恢复 + 交易互斥 + `ensureDefaultProject()`（迁移入口），并已把 `projects.json` 登记进 `server-ops-config-transaction.ts` 的固定文件集合；单测 5 项通过（默认项目幂等、重名与最后一项拒绝、损坏文件 fail closed、双实例互不覆盖）。
- [x] 主机 Store 迁移：`ServerOpsHost` 增加可选 `projectId`；读取时把缺失归属的主机补成 `ensureDefaultProject()` 的结果并双次原子提交（主文件与 `.bak` 一起补全）；新建主机直接带默认项目；未注入解析器时行为完全不变（老测试与不关心项目的调用方零改动）。主进程已按「项目 Store → 主机 Store」顺序接线。
- [x] 数据源 Store 迁移：条目补 `projectId`，缺失时归入默认项目并双次原子提交；直连条目（没有 `hostId`）的项目归属只能来自 `projectId`，已按此处理；未注入解析器时行为不变。
- [x] 项目 IPC 三层接线：主进程四个 handler（list/create/rename/delete，均带授权窗口校验与 exact-key 解析）+ `server-ops-project-preload.ts` 桥接 + `ElectronAPI` 扩展；通道已登记进注册表（handler 数量断言 56 → 60）。
- [ ] renderer atoms 与侧栏 UI：属于阶段 C，进入项目列表/连接清单时一起做，避免现在先建一套没有消费者的状态。

**阶段 B：服务与运行时**
- 连接服务与数据服务按 `projectId` 解析作用域；Agent 授权键切换。
- 审计写入补 `projectId`；审计查询支持按项目过滤。
- 数据服务直连路径保持现有实现（已就绪），补 `projectId` 校验。

> **2026-09-18 顺序修正（实施中发现）**：Agent 授权锚点换成 `projectId` 后，渲染层必须知道「当前项目」才能发起授权，而项目选择器属于阶段 C。因此 **B 不能完全先于 C**：先做 C 的最小一步（侧栏项目列表 + 当前项目状态 + atoms），再执行 B 的授权键切换；否则授权请求会因为拿不到项目身份而退化成不可用。原计划把 B 排在 C 之前，此处修正。

阶段 B 的确切改动面（供直接执行）：

| 层 | 文件 | 语义 |
| --- | --- | --- |
| shared | `types/server-ops.ts` | `ServerOpsAgentAccess` / `ServerOpsAgentAccessTarget` 的 `hostId` → `projectId`；对应 parser 与 IPC 输入 |
| main | `server-ops-agent-access-store.ts` | 键从 `(sessionId, hostId)` 改为 `(sessionId, projectId)`；保留旧键的读取迁移策略需明确（授权是易失状态，可安全丢弃） |
| main | `server-ops-ipc.ts` | GET / SET / REVOKE 的授权目标解析；`requireUserVisibleSession` 保持不变 |
| main | `server-ops-agent-facade.ts` | Agent 工具在项目范围内解析可用连接；不得因为项目授权而获得跨项目连接 |
| main | `server-ops-audit-store.ts` 及各服务写入点 | 审计补可选 `projectId`，旧记录标「未归属」不重写 |
| renderer | `ServerOpsWorkspace.tsx` | 授权 target 从 hostId 换成 projectId（依赖阶段 C 的当前项目状态） |
| tests | agent-access-store / agent-facade / server-ops-ipc / ServerOpsWorkspace / AppShell 访问 / session guard | 授权键切换必须先补失败用例再改实现 |

**阶段 C：侧栏与页面**
- [x] 项目状态层（B 的前置最小一步）：新增 `server-ops-project-controller.ts`（owner 代次 + 请求代次，激活/卸载语义与其它领域一致；失败保留上次成功列表避免侧栏闪空）+ `resolveServerOpsCurrentProjectId()`（选择失效时回落列表第一项，界面不会停留在已删除项目上）；5 项单测通过。运维+共享 899 pass / 0 fail，类型检查干净。
- [x] 项目 atoms 与工作区接线：atoms（列表/状态/错误 + 持久化的当前项目选择）与容器接入已就绪，未激活不请求、卸载不写回。
- [x] 抽屉支持项目分组（可选属性，未接线时行为不变）：`resolveServerOpsDrawerHosts()` 按项目过滤，**未迁移（没有 `projectId`）的主机归入第一个项目**，避免升级瞬间主机从侧栏消失；项目未知时返回空列表而不是把别的项目内容混进来。新增 2 项测试（过滤规则 + 渲染）。
- [x] 工作区把项目列表与选择传入抽屉：抽屉现在按项目展示服务器；切换项目时**同步把选中主机切到该项目内的第一台**（否则中间区域会继续展示上一个项目的服务器，与侧栏不一致）。未迁移主机归入第一个项目，因此升级后现有主机仍默认可见。
- [ ] 项目的新建/重命名/删除入口（主进程 handler 与 preload 已就绪，缺 UI）。

### 2026-09-18 接线完成（本轮实施记录）

- [x] **抽屉一级只留项目+统计**：新增 `ServerOpsProjectDrawer`（替换 `ServerOpsHostDrawer`），每行显示项目名与「N 服务器 · N 数据库 · N Redis」，统计来自 `summarizeServerOpsConnections()`——与项目视图共用同一份连接模型；抽屉不再展开连接、不再承载服务器编辑/删除，项目读取失败时给出原因与重试，不再回退成"全部服务器"。
- [x] **中间区域三选一**：`resolveServerOpsWorkspaceTarget()` 解析目标——停留项目视图 → `ServerOpsProjectView`（服务器/数据库/Redis 三个分组）；点服务器 → 现有能力页签（`ServerOpsWorkspaceView`，页签为 概览/终端/服务/日志/文件/Docker/审计）；点数据库/Redis → `ServerOpsDataConnectionView`（数据服务详情）。连接身份失效时回落项目视图，不把用户甩到另一条连接上。
- [x] **数据服务单连接聚焦模式**：`ServerOpsDataServicesPanel` 新增 `focusSource` 上下文，聚焦时不再读全局列表、进入即自动读只读诊断、隐藏「新建数据源」与列表；编辑/删除通过 `onSourceMutated('updated' | 'deleted')` 交回工作区重建连接清单（删除后退回项目视图）。
- [x] **移除「数据服务」页签**：`ServerOpsSection` 去掉 `'data-services'`（原先也未持久化），数据服务只作为项目下的连接入口。
- [x] **连接选择取代主机选择**：`selectedServerOpsHostIdAtom` 由 `selectedServerOpsConnectionIdAtom` 取代；SSH 主机身份由选中连接派生，文件传输收口（`useServerOpsTransferLeave`）的作用域随之变成"正在查看的服务器"。
- [ ] 待办：**新建连接仍归入「默认项目」**。`ServerOpsUpsertHostInput` 与 `ServerOpsDataSourceUpsertInput` 都还没有 `projectId`，所以在非默认项目里点「添加服务器/数据库/Redis」会把条目落到默认项目。下一步要给两条写入合同补 `projectId`（共享 parser → Store → IPC → 弹窗「所属项目」），并按约定重建 main/preload bundle。
- [ ] 待办：**跨项目跳板选择**。数据源弹窗目前只支持一个跳板主机，项目视图取本项目第一台服务器；"列出本项目连接 + 标注来源项目的其它连接"尚未实现。

### 第 2 步执行规格：页签按连接类型分流（下一步直接照此实施）

### 2026-09-18 信息架构确认（用户修订，优先于上面的抽屉实现）

用户明确要求的层级：

```
项目列表（抽屉一级，唯一内容）
  每个项目显示统计：N 个服务器 / N 个数据库 / N 个 Redis
    ↓ 进入项目
项目视图：三个分组
  ├── 服务器   → 组内再展开：每台服务器下的终端 / 文件 / Docker / 服务 / 日志
  ├── 数据库   → 每条连接进入只读诊断
  └── Redis    → 每条连接进入只读诊断
```

与当前实现的差异（必须改）：

- 抽屉**一级只放项目**，当前实现是"项目行内联展开服务器"，要改掉：抽屉不再展开连接，只显示项目与其统计。统计来自 `buildServerOpsConnections()` 按 `kind` 计数，未迁移条目归入第一个项目。
- **进入项目后才是三类分组**，服务器组内再展开具体服务器与其能力页签。这意味着"项目"是一个可以进入的视图，而不是仅抽屉中的一个筛选条件。
- 建议落地位置：**中间区域作为项目视图**（抽屉只有 240px 宽，放不下"服务器 → 再展开"四层；中间区域本来就是展示区，且现有功能页签可以整体下移为"选中服务器后的能力页签"）。抽屉内的项目行点击 = 进入该项目视图，视图内提供返回项目列表。
- 原"数据服务页签"按上一轮确认移除；数据库/Redis 只在项目视图的对应分组里出现。

前置已就绪：`server-ops-connections.ts`（统一连接模型 + `listServerOpsProjectConnections` + `resolveSelectedServerOpsConnection`）、项目状态层与 atoms、数据服务的 `projectId` 过滤、数据源弹窗的「连接方式」选择器、抽屉一级项目列表。

用户已确认：**移除「数据服务」页签**，数据服务只作为项目下的连接入口（避免两个入口指向同一批数据，且页签里的全局列表与"当前选中连接"无关）。

改动顺序（每步都可独立编译）：

1. **容器新增连接状态**（`ServerOpsWorkspace.tsx` 容器内）：读 `serverOpsProjectsAtom`、`serverOpsDataSourcesAtom`（新增，见第 2 条）、`serverOpsConnectionStatesAtom`，用 `buildServerOpsConnections()` 构造连接，用 `resolveSelectedServerOpsConnection()` 解析当前连接；新增 `selectedServerOpsConnectionIdAtom`（持久化，与主机/项目选择同一套 `atomWithStorage` 语义）。
2. **数据源 atoms**：新增 `serverOpsDataSourcesAtom` / 状态 / 错误，用 `ServerOpsDataPanelApi.listServerOpsDataSources({})` 加载一次全量（过滤在渲染层按 `projectId` 做，避免每次切项目都请求）。加载同样走控制器模式（owner 代次 + 请求代次）。
3. **页签可见性**：`ServerOpsSection` 保持枚举不变，但在渲染层按当前连接的 `kind` 过滤页签：`ssh` → 概览/终端/服务/日志/文件/Docker/审计；`database`/`redis` → 概览/数据服务详情/审计（审计仍按项目过滤）。移除 `data-services` 作为独立页签的入口，改为"选中数据连接时进入详情"。
4. **数据服务详情复用现有面板**：`ServerOpsDataServicesPanel` 已支持"全局列表 + 选中项诊断"；连接视图下需要新增一个"单连接模式"属性（只显示该数据源、直接进入诊断、隐藏新建/列表），避免为同一份能力写第二套 UI。
5. **切换连接的清理**：切换连接时按现有规则取消/丢弃在途请求（日志流先停后启、数据读取用请求代次），并在首帧不得显示上一条连接的内容（沿用 `getServerOpsOverviewInstanceKey` 的 key 机制）。
6. **测试**：连接模型已有 4 项用例；本步需要补：页签随 `kind` 变化、选中连接失效回落、切连接首帧不串内容、数据服务页签入口确实不再出现。

不要做的事：不改 `ServerOpsSection` 枚举的持久化格式（老用户的 `activeSection` 仍可解析，遇到已移除的 `data-services` 时回落到 `overview`）；不改 SSH 派生页签的运行时边界。
- 工作台左侧抽屉改为项目列表；进入项目后展示连接清单（SSH / 数据库 / Redis）。
- 选中 SSH 连接后再展示终端/文件/Docker/服务/日志；数据库/Redis 直接进入数据服务详情。
- 数据源弹窗补「所属项目」与（已实现的）「连接方式」。

**阶段 D：测试与迁移验证（一次性更新）**
- [x] 把按 `hostId` 归属编写的运维/数据服务测试迁移到 `transport` + 全局列表契约：5 个测试文件全部更新，运维 + 共享 + preload 共 951 pass / 0 fail（过程中测试抓到"直连数据源在编辑/提交/删除三条路径被主机门禁静默拦掉"的真实缺陷，已修）。
- 迁移验证：老 `hosts.json` 只读旧 schema 的夹具、未知字段、损坏文件、并发写、跨进程锁。
- 目标：定向回归全绿 + 全仓 typecheck + 真实 Electron 面板验收（含「只有一个数据库的项目」与「跨项目跳板」两条路径）。

## 7. 风险与不做的事

| 风险 | 处理 |
| --- | --- |
| 权限键重定义影响 Agent 授权与审计 | 阶段 B 单独提交，先补回归用例再改键；旧审计记录不重写 |
| 迁移写坏现有主机 | 迁移只读旧 schema + 原子写新文件并保留 `.bak`；宿主文件损坏时 fail closed，不降级为空 |
| 侧栏大改导致工作台回归 | 阶段 C 保留旧主机视图开关一段时间，先并跑再切换 |
| 跨项目跳板带来的越权 | 跳板仅影响网络路径，不改变授权与审计归属；选择跨项目跳板时在 UI 明确标注来源项目 |

不做：多用户/多租户与服务端同步、把文件管理拆成独立连接、Kubernetes 等新连接类型（留作后续扩展点）。

## 8. 验收标准

1. 新建一个只含数据库的项目，无需任何 SSH 主机即可连接 `127.0.0.1:13306` 并读到只读诊断。
2. 一个项目内可同时容纳多条 SSH 连接、多个数据库与 Redis，各自独立登录与断开，互不影响。
3. 老数据迁移后主机与数据源完整可见；`known-hosts.json` 不变；审计历史不丢失。
4. Agent 授权以项目为粒度生效，撤销后项目内所有连接的 Agent 能力同时失效。
5. 定向回归全绿、全仓 `bun run typecheck` 通过、真实 Electron 面板两条路径（仅数据库 / 跨项目跳板）目视验证通过。
