# Canvas 生图节点工作台与节点扩展菜单设计

## 状态

- 日期：2026-08-28
- 结论：已由用户逐段确认
- 范围：Canvas 生图节点完整工作台、Design Job 的 Canvas 目标适配、图片模块配置与版本、节点侧 `+` 类型悬浮菜单
- 前置规格：
  - `2026-08-24-design-job-transparency-design.md`
  - `2026-08-25-canvas-session-agent-orchestration-design.md`
  - `2026-08-26-canvas-node-operations-and-resilient-errors-design.md`
  - `2026-08-27-canvas-multi-node-workbench-design.md`
  - `2026-08-28-canvas-node-popover-design.md`

## 结论

Canvas 生图节点不能继续显示“节点已创建”的占位文字，也不能直接嵌入项目级旧 `DesignInspector`。每个生图节点必须成为独立、可执行、可恢复的图片创作模块，其配置、当前图片、任务、取消、重试和历史版本统一归属：

```text
projectId + canvasId + nodeId + imageModuleId
```

图片执行继续复用现有 Pi Agent、生图模型 profile、Design Job、trace 和 Design Asset 安全链，不创建第二套生图执行器。`DesignJobManager` 增加明确的目标联合：旧 Design 任务继续落入旧 Design 画布；Canvas 图片任务不创建旧画布 job 节点，结果直接提交给目标图片模块。

节点交互保持明确分工：单击只选中；双击节点主体或点击右上角放大按钮才打开工作台；节点侧 `+` 打开类型悬浮菜单，选择类型后创建下游节点并自动连线。

## 要解决的问题

当前多类型 Canvas 只完成了节点基础层：

1. `CanvasNodeWorkbenchOverlay` 在图片节点没有真实 children 时只显示下一步占位文字；
2. `NativeCanvasWorkspace` 只为 Agent 节点挂载真实工作台；
3. 图片 `config.json` 只有提示词、模型和当前素材三个基础字段，没有读写 IPC、任务目标或历史映射；
4. 现有 `DesignInspector` 使用项目级 Renderer 状态，多个 Canvas 图片节点会串提示词、模型、选区和结果；
5. 现有 Design Job 必须在旧 Design 画布创建 job 节点，成功后再替换为 asset 节点，无法表达“结果属于某个 Canvas 图片模块”；
6. 节点侧 `+` 当前把“扩展节点”与固定类型创建混在一个回调中，无法让用户选择下游节点类型。

问题本质不是补表单，而是让现有可信图片执行链支持第二种明确目标，同时保持多节点隔离、任务恢复和旧 Design 行为不回退。

## 范围

### 本阶段包含

- 图片节点提示词、模型、比例、尺寸和项目上下文配置；
- 直接上游已提交内容摘要；
- 生成、取消、重试和重启中断恢复；
- 当前图片、成功版本历史和单次任务详情；
- 最终图片提示词、上下文引用、Thinking 和执行日志按需查看；
- Canvas 图片任务与旧 Design 任务的目标隔离；
- 节点侧 `+` 的 Agent、生图、文档、原型类型菜单与自动连线；
- 配置 schema v1 到 v2 的兼容迁移；
- IPC 四层合同、公开错误清洗和真实客户端验证。

### 本阶段不包含

- 单击节点打开详情；
- 视频节点或视频生成；
- 一次图片节点内并发多个运行任务；
- 未连线节点之间的隐式上下文共享；
- 自动递归运行整张 Canvas；
- 完整图片局部编辑、蒙版编辑或批量生产；
- 重写旧 Design 页面或迁移其已有任务布局；
- 文档和原型完整工作台，它们继续使用已有基础占位层并另立实现规格。

## 用户交互

### 节点选择与工作台

- 单击节点只更新选区，不打开或关闭工作台；
- 双击节点主体打开该节点工作台；
- 点击节点右上角放大按钮打开该节点工作台；
- 点击放大、`+`、菜单项或工作台内部控件时阻止单击、双击和拖动事件穿透；
- 同一 Canvas 同一时刻只挂载一个完整工作台；
- 工作台仍锚定节点显示，不改变节点持久化尺寸、位置、连线端点或 viewport；
- 创建下游节点后只选中新节点，不自动打开工作台。

### 生图工作台布局

工作台沿用现有节点覆盖层和主题变量，桌面宽度内采用预览与配置双区布局，窄窗口改为纵向滚动，不嵌套装饰性卡片。

左侧结果区包含：

- 固定比例预览区域；
- 无结果、加载、排队、运行、失败、取消和中断状态；
- 当前采用图片；
- 成功版本缩略图列表；
- 历史版本预览和“设为当前”；
- 当前任务或来源任务的详情入口。

右侧配置区按以下顺序排列：

1. 提示词；
2. 生图模型；
3. 项目上下文三态：自动、使用项目、不使用项目；
4. 画面比例：`1:1`、`16:9`、`4:3`、`9:16`、`3:4`；
5. 图片尺寸：`auto`、`1K`、`2K`、`4K`；
6. 直接上游已提交内容摘要；
7. 生成、取消或重试主操作。

没有可用生图模型时，保留模型配置入口并禁用生成。运行中主操作切换为取消；失败、取消或中断任务显示重试。任务详情默认只加载轻量摘要，用户展开 Thinking 或执行日志时才读取完整 trace。

### 保存行为

- 提示词和配置变化进入当前 `imageModuleId` 的本地草稿，并短延迟自动保存；
- 图片工作台向现有工作台切换协调器注册 `commitDraft()`，关闭、切换节点、切换 Canvas 和 recovery 均复用既有 dirty 边界；
- 点击生成前必须先完成当前配置保存，再使用主进程返回的确定 revision 创建任务；
- 配置保存失败时不创建付费任务，保留本地草稿和明确重试入口；
- revision 冲突不静默覆盖另一个窗口，保留本地草稿并要求重新加载权威配置；
- 模型、比例、尺寸和上下文变化只影响下一次“生成”，不改写已经创建的任务。

### 节点侧扩展菜单

节点侧 `+` 复用顶部添加菜单的类型定义和 Radix `Popover` 基础能力：

- 菜单锚定节点侧 `+`，不使用居中 Dialog；
- 依次显示 Agent、生图、文档、原型和禁用的“视频 · 即将支持”；
- 点击画布空白、按 `Escape`、再次点击 `+` 或选择可用类型后关闭；
- Canvas 不可写或当前节点不允许扩展时，`+` 保持禁用且不能打开菜单；
- 选择类型后使用现有内容/Agent 创建事务，在源节点右侧创建下游节点并同时提交 `source.output -> target.input` 连线；
- 创建失败保留源节点、选区、已有节点位置和 viewport，不留下孤立节点或孤立边；
- 下游节点落点沿用确定性的源节点右侧避让逻辑，不移动已有节点。

Renderer 必须把当前含义混乱的 `onExpand` 拆为“打开工作台”和“创建下游节点”两个明确命令，避免详情交互与图结构 mutation 继续共享命名和事件路径。

## 架构

### 单引擎、双目标

保留唯一 `DesignJobManager`，新增目标联合：

```ts
type DesignJobTarget =
  | {
      kind: 'design-canvas'
      nodeId: string
      position: DesignPoint
    }
  | {
      kind: 'canvas-image'
      canvasId: string
      nodeId: string
      imageModuleId: string
    }
```

旧 Design Job 的行为不变：创建旧 Design job 节点，成功后替换为 asset 节点。Canvas 图片 Job：

- 创建时验证项目、Canvas、节点和 `imageModuleId` 的当前归属；
- 不创建旧 Design job 节点；
- 继续创建隔离的内部 Pi Agent 会话；
- 继续使用可信模型快照、上下文编排、图片工具路由、输出校验、素材导入和 trace；
- 成功后把 Design Asset 提交给目标图片模块并修复 Canvas 节点投影；
- 只广播当前图片模块的任务/结果变化，不伪造旧 Design 画布结构变化。

现有素材服务需要增加“只导入项目素材、不放置旧 Design 节点”的窄模式。该模式必须复用原有文件身份、图片签名、大小、像素、缩略图和原子提交校验，只改变成功后的布局目标；禁止为 Canvas 另写一套文件导入逻辑。素材写入仍产生正常的项目 Asset 变化事实，但旧 Design `nodes` 数组保持不变。

### Canvas 图片模块适配层

增加窄的 Canvas 图片模块服务，职责仅包括：

- 读取、迁移和 CAS 保存图片配置；
- 验证 Canvas 节点与 `imageModuleId` 归属；
- 从 Design Job 目标索引读取该模块任务；
- 创建带 Canvas 目标的 Design Job；
- 取消、重试和恢复时复核任务目标；
- 成功后采用输出素材并维护 Canvas 节点快速投影；
- 提供 Renderer 需要的模块快照和作用域事件。

该适配层不执行模型、不解析供应商响应、不复制素材文件，也不复制旧 `DesignInspector` 的项目级状态。

## 权威数据模型

### 图片配置 schema v2

每个图片模块继续保存在：

```text
nodes/<image-module-id>/config.json
nodes/<image-module-id>/meta.json
```

`config.json` 升级为：

```ts
interface CanvasImageModuleConfigV2 {
  schemaVersion: 2
  kind: 'image'
  contentId: string
  revision: number
  createdAt: number
  updatedAt: number
  prompt: string
  selectedModelProfileId: string | null
  aspectRatio: '1:1' | '16:9' | '4:3' | '9:16' | '3:4'
  imageSize: 'auto' | '1K' | '2K' | '4K'
  contextMode: 'auto' | 'project' | 'none'
  adoptedAssetId: string | null
}
```

历史任务和历史素材 ID 不复制进配置。它们由带 `canvas-image` 目标的 Job 和 `outputAssetId` 派生，避免配置、journal 和素材目录形成三套列表事实。

新图片节点默认使用 `1:1`、`auto` 和 `auto` 上下文。创建事务在当时存在可用项目生图模型时把 profile ID 复制进新模块；此后模型选择独立属于该模块。没有可用模型时保存 `null`，工作台显示配置入口。

schema v1 迁移保持原提示词、模型和 `adoptedAssetId`，补入三个稳定默认值。迁移在可信 Canvas LOAD/图片模块 LOAD 边界内执行，使用现有稳定目录能力和原子写；未知字段、非法枚举、超长提示词或身份漂移必须 fail closed，禁止 Renderer 指定路径。

### revision 与原子提交

配置保存输入必须包含完整图片目标和 `expectedConfigRevision`。主进程在同 Canvas 串行边界内重新验证节点归属和当前 revision，再原子写 `config.json`，最后提交公共 `meta.json`。如果多文件提交结果不确定，保留可恢复事务证据，LOAD 只完成已经可证明的提交，不猜测覆盖。

`config.json.adoptedAssetId` 是当前图片的权威事实。`CanvasImageNode.adoptedAssetId` 只作为折叠卡片快速展示投影：

- 采用图片时先提交模块权威配置；
- 再以最新 Canvas revision 更新节点投影；
- 投影写失败不回滚已经采用的图片；
- 后续 LOAD 比较两者并幂等修复投影；
- 工作台始终以模块配置为准，折叠卡在修复前可以显示“正在同步”，不能把旧投影反写回配置。

## 任务与版本合同

### Job journal 兼容

新 journal 固化 `target`。旧 journal 的 `nodeId + position` 仅作为 `design-canvas` 兼容输入，在读取时规范化；不得把缺失一半目标字段的半升级 journal 当作合法记录。

公开 `DesignJobRecord` 提供经过清洗的目标摘要，使 Canvas 适配层可以严格过滤任务。Renderer 不能仅凭 `jobId` 操作图片模块任务；取消、重试和详情读取都必须同时提交图片目标，主进程复核目标一致后才执行。

### 生成

同一图片模块最多存在一个 `queued` 或 `running` Job，不同图片模块可以并行。创建 Job 时固化：

- 当前配置 revision；
- 提示词、模型快照、比例和尺寸；
- 项目上下文模式；
- 直接入边的已提交输入快照；
- Canvas 图片目标；
- 新 `creativeTaskId` 和首次 attempt。

比例与尺寸作为结构化配置保存，在主进程执行适配边界编码为现有图片 Agent/工具可消费的稳定约束。Renderer 不能通过自行拼接隐藏 prompt 绕过枚举校验。

### 项目上下文与连线上下文

`contextMode` 只控制项目代码和创作资料库：

- `auto`：Agent 按任务判断是否读取；
- `project`：要求 Agent 在授权范围内读取；
- `none`：不读取项目代码和创作资料库。

Canvas 连线是另一条显式输入合同，不受该三态开关影响。图片任务只读取直接入边节点的已提交快照，不递归遍历整张图：

- Agent：最近一次明确输出的有界摘要和选定附件；
- 图片：当前采用素材的安全引用；
- 文档：已提交 Markdown revision 的有界摘要；
- 原型：已提交版本的描述或安全快照。

执行时固化 node ID、内容 revision、素材 ID 和摘要哈希。上游之后变化只把图片节点标记为待更新，不修改已创建 Job，也不自动再次生图。

### 成功、失败和版本

Canvas 图片 Job 的输出仍导入项目级 Design Asset，以便多个 Agent、Canvas 和旧 Design 素材库共享同一安全素材。输出不放置到旧 Design 画布。

成功提交顺序：

1. 校验并导入 Design Asset；
2. 在 Job journal 保留 terminal pending 对账事实；
3. 把输出素材自动采用为图片模块当前版本；
4. 修复 Canvas 节点 `adoptedAssetId` 投影；
5. 将 Job 收敛为 `succeeded` 并广播模块作用域事件；
6. 转存 trace 并回收内部执行会话。

步骤中断时由现有 Design 恢复入口和图片模块适配层继续对账，不得把已经导入或已经采用的结果误标为失败。terminal pending 未收敛前阻止该模块创建新任务，避免旧恢复结果覆盖更新版本。

生成成功自动成为当前图片。成功版本历史按任务时间展示；点击历史缩略图只预览，显式“设为当前”才修改 `adoptedAssetId`。失败、取消或中断不改变当前图片。

### 取消、重试、重启与删除

- 取消只作用于目标完全匹配且仍排队/运行的 Job；
- 重试沿用原 `creativeTaskId`，递增 attempt，并固化原任务的提示词、模型、比例、尺寸、上下文模式和输入快照；
- 用户修改配置后点击“生成”创建新的 creative task，不把配置变化偷渡进旧任务重试；
- 应用重启后排队和运行任务转为 `interrupted`，不自动恢复付费执行；
- 图片模块 LOAD 展示中断状态和重试入口；
- 删除含运行任务的图片节点必须先完成权威取消，再进入现有节点删除/回收事务；
- 回收区保留相同 `imageModuleId`，恢复后重新取得对应任务和版本；
- 节点进入回收区不会删除共享 Design Asset，永久任务/素材清理继续遵守现有引用检查。

## IPC 四层合同

共享层增加图片模块目标、配置、快照、Job 操作和作用域事件类型，并为以下能力提供稳定通道：

- 加载图片模块；
- 保存图片配置；
- 创建图片任务；
- 取消图片任务；
- 重试图片任务；
- 采用历史素材；
- 图片模块变化事件。

主进程 handler 必须验证发送窗口、项目授权、Canvas 当前存在、节点类型、`imageModuleId`、revision、模型可用性、任务目标和素材归属。所有错误先转换为稳定公开信封，路径、内部 session、供应商凭据和未清洗异常不能进入 Renderer。

Preload 只暴露窄的类型安全方法和取消订阅函数。Renderer `design-adapter` 为图片模块提供中文 fallback，并按 `projectId + canvasId + nodeId + imageModuleId` 过滤事件；旧 Design API 保持兼容。

节点侧 `+` 不新增另一套创建 IPC，继续调用已有 Agent/内容节点创建事务，并携带现有 relationship 输入以原子创建边。

## 错误与恢复界面

- 配置加载失败：在图片工作台显示局部错误和重试，不阻断整张 Canvas；
- 配置损坏：显示“图片配置损坏”，保留节点删除/回收入口，不用空默认值覆盖磁盘；
- revision 冲突：保留本地草稿，提示配置已在其他窗口更新；
- 模型已删除、停用或凭据失效：禁用生成，保留原配置和模型设置入口；
- 配置保存失败：禁止创建 Job；
- Job 创建失败：保留配置和当前图片，不创建假运行状态；
- 任务失败：显示清洗后的业务错误、重试和任务详情；
- 输出校验失败：保留 trace，不采用不可信文件；
- 成功提交不确定：显示“正在恢复生成结果”，等待权威对账，不能同时重试；
- 节点侧创建失败：菜单关闭，源节点与 viewport 不变，在节点附近显示公开错误。

异步回调必须复核完整图片目标、工作台挂载代次和当前 operation generation。Canvas 切换、工作台切换、recovery、删除或卸载后，迟到 LOAD/SAVE/JOB 结果不得更新新节点状态。

## 性能与资源

- `DesignJobManager` 在启动/恢复时建立按图片目标索引，工作台加载不逐次扫描全部 journal 文件；
- 只有展开的图片节点加载完整配置、任务摘要和媒体 lease；
- 历史缩略图按需加载，原图只在当前预览或用户选择历史版本时加载；
- 收起、切换 Canvas 和卸载时释放媒体授权、对象 URL、trace 详情和编辑器临时态；
- 模块事件只刷新目标 `imageModuleId`，不重载整张 Canvas；
- 同一节点单运行任务限制降低重复付费和内存占用，不影响不同节点并行；
- 节点侧 Popover 只在打开时挂载，不增加持续画布开销。

## 关联业务影响

- 旧 Design：任务布局和交互不变，但 Job journal parser 增加目标迁移，必须有完整回归；
- Design Asset：Canvas 输出进入同一项目素材库，继续受删除引用和媒体授权规则保护；
- Agent：仍由 Pi Agent 执行 Design 任务，普通 Agent 会话、搜索、LAN 和移动端继续排除内部执行会话；
- Canvas：新增图片模块读写和作用域事件，不修改无连线即独立、直接入边输入和待更新语义；
- 节点创建：顶部添加仍创建独立节点，节点侧 `+` 创建带连线的下游节点，两者不能共用落点语义；
- 文档/原型：只出现在扩展菜单，本阶段不增加其完整工作台。

## 测试与验收

### 共享类型与 Store

- schema v1 正常迁移为 v2，保留已有字段并补入稳定默认值；
- 非法枚举、未知字段、超长提示词、身份漂移和损坏 JSON 被拒绝；
- 配置 CAS 正常保存、revision 冲突和提交不确定恢复；
- 权威 `adoptedAssetId` 与 Canvas 节点投影的正常更新和 LOAD 修复。

### Job 与恢复

- 旧 journal 规范化为 `design-canvas`，旧任务行为不变；
- Canvas Job 不创建旧 Design job 节点；
- 两个图片模块的配置、运行、取消、重试、事件和结果完全隔离；
- 同模块拒绝第二个 active Job，不同模块允许并行；
- 生成成功自动采用，失败/取消/中断保留旧图；
- 历史版本显式采用；
- 重试复用原任务快照，新生成使用最新配置；
- terminal pending 恢复、重启 interrupted 和删除前取消；
- 输出 Asset 仍满足项目归属、图片签名、大小、路径和媒体 lease 安全边界。

### IPC 与 Renderer

- 四层方法参数、返回和事件取消订阅合同一致；
- 伪造 Canvas、节点、`imageModuleId`、revision、jobId 或 assetId 被主进程拒绝；
- 工作台完整展示提示词、模型、上下文、比例、尺寸、当前图片和历史版本；
- 生成前 flush 配置，保存失败不创建任务；
- final prompt、上下文引用、Thinking 和日志按需加载；
- 单击只选中，双击和放大按钮打开工作台；
- 节点侧 `+` 打开类型菜单，Agent/生图/文档/原型创建并自动连线，视频禁用；
- 菜单、放大和工作台控件无点击/双击/拖动事件穿透；
- 深浅主题、键盘焦点、Escape、窄窗口和长错误文本可用。

### 完成验证

1. 先运行图片模块、Design Job、Canvas 创建和 Renderer 定向 BDD 测试；
2. 运行 `bun run typecheck`；
3. 运行 `bun run electron:build`；
4. 启动最新 Proma 开发客户端；
5. 真实控制鼠标验证节点单击、双击、放大、节点侧 `+` 菜单和四类下游创建；
6. 在两个独立图片节点分别配置并执行生图，确认结果、提示词、Thinking、历史版本和状态不串联；
7. 验证取消、失败后的重试、工作台关闭重开和应用重启中断恢复；
8. 若本机模型或凭据不可用，必须明确记录真实付费链路未执行的原因，并以可用的失败/禁用状态和自动化执行链覆盖作为次优证据，不能声称真实生图成功。

## 验收标准

- 图片节点不再显示占位文字，所有已确认配置和执行能力可用；
- 每个图片节点的配置、任务和结果严格按完整目标隔离；
- Canvas 生图真实经过现有 Pi Agent 和可信图片模型链；
- 旧 Design 画布不会因 Canvas 生图出现额外 job 或 asset 布局节点；
- 生成成功、失败、取消、重试和重启恢复不会丢失当前图片或错误采用其他节点结果；
- 用户可以查看每个版本的最终提示词、上下文引用和可用任务 trace；
- 单击、双击、放大和节点侧 `+` 的行为与本规格一致；
- 相关测试、类型检查和 Electron 构建通过，真实客户端完成鼠标交互验证。
