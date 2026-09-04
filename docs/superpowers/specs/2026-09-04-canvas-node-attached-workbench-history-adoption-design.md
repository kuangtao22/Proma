# Canvas 节点跟随详情与历史版本采用设计

## 目标

修复 Canvas 节点详情工作台被锁定在屏幕坐标的问题，并收敛图片版本操作：详情工作台必须跟随所属节点移动，图片生成结果统一进入“历史版本”，用户在历史版本中明确选择是否设为默认。

本设计采用方案 A：工作台位置绑定节点，尺寸保持屏幕像素稳定；用户可以拖动工作台，拖动结果保存为该节点独立的相对偏移。

## 当前问题与根因

### 详情工作台被锁定

`CanvasNodeWorkbenchOverlay` 当前位于 Canvas surface 的覆盖层，不继承 XYFlow 的 viewport transform。首次打开时，Renderer 根据节点屏幕矩形计算绝对位置，随后把该屏幕坐标写入会话级 `workbenchPosition`。画布平移、缩放或节点拖动只会更新节点的屏幕投影，工作台继续读取旧的绝对屏幕坐标，因此不会随节点移动。

问题本质不是覆盖层脱离 XYFlow，而是持久化了错误的坐标语义。覆盖层脱离 XYFlow 可以让表单、文字和按钮保持稳定尺寸，应继续保留；位置则必须由节点的实时屏幕投影与用户偏移共同派生。

### 图片版本入口重复

图片详情同时提供候选批次、历史版本和历史预览后的外置“设为当前”按钮。三个入口都在表达“查看并采用生成结果”，增加理解成本，也让单节点生成看起来必须经过额外批次验收。

候选批次在主进程仍承担批量一致性、重试和崩溃恢复职责，但这些事务细节不应成为单节点详情的主要用户模型。用户只需要理解“历史版本”和“默认版本”。

## 交互设计

### 节点跟随工作台

- 工作台继续渲染在 Canvas surface 覆盖层，宽高使用固定屏幕像素，不随 Canvas zoom 缩放。
- 工作台屏幕位置按 `节点实时屏幕锚点 + 当前节点相对偏移` 计算。
- 平移或缩放画布、拖动节点时，节点锚点变化，工作台同步移动。
- 用户拖动工作台标题栏时，只更新当前节点的相对偏移；切换到其它节点时使用其它节点自己的偏移或首次默认偏移。
- 首次打开某节点时，继续优先放在节点右侧；空间不足时尝试左侧，最后在当前可视区域内选择可操作位置。首次位置转换为相对节点的偏移后保存。
- 画布视口变化时不重新夹紧或改写偏移。节点移出视口时，工作台可以一起移出视口，避免再次形成“贴在屏幕边缘”的锁定效果。
- 用户主动拖动或调整尺寸时，手势过程仍保证标题栏、关闭按钮和缩放手柄可操作；只在直接手势边界使用当前 surface 约束，不把 viewport 导致的临时裁剪写回偏移。
- 关闭工作台、切换节点、切换画布和现有 dirty 草稿确认流程保持不变。

### 图片历史版本

- 删除图片详情中的“候选批次”面板及“查看候选批次”等用户可见入口。
- 删除大图预览下方仅在预览历史时出现的外置“设为当前”按钮。
- “历史版本”成为查看与采用图片生成结果的唯一入口。
- 点击历史缩略图只切换大图预览，不改变默认版本，也不触发下游待更新。
- 当前正式采用版本在历史项上显示“默认”状态，不使用“当前”或“候选”等并行术语。
- 每个非默认历史项提供明确的图标按钮，名称为“设为默认”；按钮使用现有 icon button、Tooltip 和可见焦点样式。
- 点击“设为默认”继续调用现有单素材采用命令。采用成功后，权威配置、Canvas 卡片、历史版本状态和下游待更新标记通过现有刷新链路同步。
- 采用进行中时禁用全部“设为默认”操作，并在被点击版本上提供可识别的加载状态，避免并发切换；失败沿用图片模块现有错误反馈，不伪装成功。
- 只读 Canvas 允许预览历史版本，但“设为默认”按钮保持可见且禁用，并通过 Tooltip 说明当前画布只读，不能产生写入。

### Canvas 卡片

- 卡片继续展示 `adoptedAssetId` 对应的默认图片，卡片展示内容与下游实际消费内容一致。
- 删除由活跃候选批次驱动的“有新版本”“部分完成”等候选标记。
- 新生成但未采用的结果只出现在历史版本中，不自动替换卡片，也不自动触发下游重新运行。

## 状态与数据模型

### Renderer 视图状态

会话级 Canvas 视图状态把单一绝对位置：

```ts
workbenchPosition: { x: number; y: number } | null
```

替换为按节点隔离且有界的相对偏移：

```ts
workbenchOffsetsByNodeId: Record<string, { x: number; y: number }>
```

偏移属于 `sessionId + projectId + canvasId + nodeId` 对应的 Renderer 运行期视图事实，不写入共享 Canvas 文档，不影响其它会话或客户端。

该 Map 沿用工作台尺寸 Map 的有界策略，最多保留 64 个节点条目。尺寸和偏移可以在同一次几何更新中提交，但保持各自独立字段，避免用户只调整尺寸时重写位置。

### 坐标转换

节点锚点使用当前 `nodeScreenRect.left/top`。已有偏移时：

```text
screenPosition.x = nodeScreenRect.left + offset.x
screenPosition.y = nodeScreenRect.top + offset.y
```

首次打开时先使用现有右侧、左侧、可视区回退规则得到 `initialScreenPosition`，再转换为：

```text
offset.x = initialScreenPosition.x - nodeScreenRect.left
offset.y = initialScreenPosition.y - nodeScreenRect.top
```

用户拖动结束时，把最终屏幕位置反向转换为相对偏移后只提交一次。高频 pointer move 继续只更新 Overlay 局部预览，避免每帧重写 Jotai Map。

手势期间若节点或 viewport 同时变化，以手势开始时捕获的节点锚点和初始偏移完成本次拖动；手势结束后的下一次 render 再接管最新节点投影，避免位置跳变和 stale closure 覆盖。

### 候选批次边界

本期只移除候选批次的 Renderer 用户界面，不删除以下后台能力：

- candidate batch Store、Service、journal 与恢复事务；
- Job 终态向候选批次登记结果的链路；
- 批量采用、继续补齐、放弃和崩溃恢复所需的主进程合同；
- 现有 candidate batch 后端测试。

Canvas 初始 `LOAD` 不再读取或返回 `activeImageCandidateBatches`。图片工作台已经通过 `LOAD_IMAGE_MODULE` 的 `imageVersions` 获得当前节点成功版本，Renderer 不需要为隐藏的候选界面扫描活跃批次摘要。

共享类型可保留 `activeImageCandidateBatches` 的兼容解析，避免旧客户端或历史调用立刻失效；新主进程返回中不再填充该可选字段。候选批次四类 IPC 暂不删除，后续若确认无其它内部调用，再以独立兼容清理任务处理。

## 组件边界

### `CanvasNodeWorkbenchOverlay`

- 接收节点实时屏幕矩形、节点相对偏移和固定屏幕尺寸。
- 负责屏幕位置派生、首次偏移计算、局部拖动/缩放预览和手势结束提交。
- 不读取 XYFlow 实例，不持久化共享文档，不感知图片版本业务。

### `NativeCanvasWorkspace`

- 继续负责把当前节点投影矩形传给 Overlay。
- 从当前 Canvas 会话视图读取、更新节点级偏移和尺寸。
- 不再创建、挂载或向卡片/工作台传递候选批次 Renderer controller。
- 继续把历史版本采用操作接到现有 `imageModule.adoptAsset`。

### `CanvasImageWorkbench`

- 只消费 `imageVersions`、Asset、Job 和 `adoptedAssetId` 来渲染历史版本。
- 历史缩略图负责预览，单项图标按钮负责设为默认，两者为独立交互目标。
- 不接收候选批次 props，不渲染候选批次面板。

### 主进程 Canvas LOAD

- 不再为 Renderer 初始画布加载调用 `listActiveSummaries()`。
- 不改变图片模块 LOAD、单素材采用事务和 candidate batch 恢复服务。

## 错误与边界状态

- 节点在工作台打开期间被删除：沿用现有选区/展开状态清理，Overlay 卸载，不保留悬空视图。
- 节点投影暂不可用：暂不挂载 Overlay，等待下一次有效投影；不把默认 DOMRect 或伪造偏移写入真实状态。
- surface 变窄：尺寸继续收进可用区域；节点跟随位置不因窗口缩放而永久改写。
- 历史 Asset 缺失：该版本不渲染为可采用项，沿用 `imageVersions + jobs + assets` 的交集规则。
- 默认 Asset 不在历史列表：大图与导出仍按权威配置处理，历史列表不伪造版本。
- 采用发生 revision 冲突或事务状态不确定：显示现有稳定错误并要求重新加载，不能提前更新“默认”标记。
- 连续点击采用：复用图片模块已有单操作/冲突控制，避免并发切换默认版本。

## 关联业务影响

- Agent、文档和 WebView 工作台共享 Overlay，因此都会获得节点跟随行为；其正文、保存和执行合同不变。
- 图片卡片不再读取候选批次摘要，只读取正式采用 Asset，强化卡片展示与下游输入一致性。
- 下游待更新只在现有采用事务成功后产生，不因预览或生成成功提前传播。
- candidate batch 后台事务继续服务批量执行与恢复，Agent 工具和主进程不会因 UI 隐藏失去一致性保护。
- 不修改 IPC 通道、图片 Asset 结构、Canvas 文档 schema 或默认 Skill。

## 性能与资源

- viewport 或节点变化只执行常数级坐标加法，不读取 DOM 树、不触发磁盘 I/O。
- 工作台拖动和缩放继续使用局部 React state 预览，手势结束才更新一次 Jotai 状态。
- 节点偏移 Map 最多 64 项，内存开销有界；不写入共享 Canvas 文档，不增加自动保存频率。
- Canvas `LOAD` 移除活跃候选批次摘要扫描后，减少一次有界目录读取与 JSON 解析。
- 历史版本继续使用缩略图懒加载，不新增原图并发加载。

## 测试策略

采用 BDD 风格先写失败测试，再修改生产代码。

### Overlay 与 Atom

- Given 工作台已有节点相对偏移，When viewport 平移导致节点屏幕矩形移动，Then 工作台同步移动相同像素且宽高不变。
- Given Canvas zoom 改变节点屏幕矩形，When 重新渲染，Then 工作台跟随新锚点但固定屏幕尺寸不缩放。
- Given 用户拖动工作台，When 手势结束，Then 只提交一次相对当前节点的偏移。
- Given 用户依次调整两个节点，When 来回切换，Then 两个节点恢复各自偏移。
- Given 偏移条目超过上限，When 新节点提交偏移，Then 淘汰最早条目且不修改历史对象。
- Given viewport 把节点移出视口，When 工作台派生位置，Then 不因 surface clamp 停留在屏幕边缘。

### 图片工作台

- Given 图片模块存在活跃候选批次，When 渲染详情，Then 不出现“候选批次”“查看候选批次”“采用已成功项”等文案。
- Given 预览非默认历史版本，When 渲染，Then 大图切换但预览区外不出现“设为当前”。
- Given 历史列表包含默认与非默认版本，When 渲染，Then 默认项显示“默认”，非默认项显示可访问名称为“设为默认”的图标按钮。
- Given 用户点击非默认版本的采用按钮，When 事件触发，Then 调用现有 `onAdoptAsset(assetId)` 且不把缩略图点击误当采用。
- Given Canvas 只读，When 渲染历史版本，Then 可以预览但不能发起采用。

### Workspace 与主进程

- Given 原生 Canvas 工作区加载，When 组合 Renderer controller，Then 不再创建或挂载候选批次 controller，也不向卡片投影候选状态。
- Given Canvas 执行 LOAD，When 项目存在活跃候选批次，Then 返回权威 Canvas 快照但不调用 `listActiveSummaries()`、不附加 `activeImageCandidateBatches`。
- 继续运行 candidate batch Store、Service、Job 终态同步和采用恢复测试，证明后台恢复能力未被删除。
- 继续运行图片模块采用测试，证明设置默认后配置、Canvas 节点和下游待更新保持原子一致。

## 验收标准

- 平移、缩放画布或拖动节点时，详情工作台始终与所属节点保持同一相对关系，表单尺寸和文字大小不变。
- 用户拖动工作台后，当前节点恢复自己的相对位置，不污染其它节点。
- 图片详情不再出现任何候选批次用户界面或外置“设为当前”按钮。
- 历史版本同时承担预览与明确“设为默认”入口，预览不会改变卡片和下游输入。
- 卡片始终展示正式采用版本；设置默认成功后，卡片、历史标记和下游待更新状态同步变化。
- candidate batch 后台恢复与批量一致性测试继续通过。
- 定向测试、`bun run typecheck`、Renderer build 与 `git diff --check` 通过。

## 非目标

- 不删除 candidate batch 的磁盘格式、Service、IPC 或恢复 journal。
- 不自动采用最新生成结果，不自动运行下游付费任务。
- 不为历史版本增加删除、重命名、并排对比或批量清理。
- 不把工作台几何写入共享 Canvas 文档或跨客户端同步。
- 不改变图片生成模型、提示词、参考图绑定和 Asset 文件生命周期。

## 对既有设计的修订

本规格修订 `2026-09-01-canvas-image-candidate-batch-design.md` 的用户界面部分：候选批次不再作为 Canvas 卡片和图片详情中的可见产品概念，成功输出统一通过历史版本呈现；该文档定义的后台批次一致性、采用事务、journal 和恢复规则继续有效。
