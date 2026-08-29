# Canvas 图片比例与 Agent 场景上下文设计

## 目标

修复两个彼此独立但同时影响 Canvas 使用连续性的问题：

1. 已采用素材的生图节点按图片真实比例展示预览，避免固定横向容器裁切主体。
2. Canvas Agent 明确知道自己已位于当前 Canvas，不能再要求用户创建画板或打开 Design 面板。

## 图片节点

- `CanvasImagePreview` 在现有安全缩略图 URL 之外携带素材 `width` 和 `height`。尺寸来自已经验证并持久化的 `DesignAsset`，Renderer 不重复读取或解码图片。
- 节点宽度继续固定为 288px。标题栏固定为 48px，预览区按 `width / height` 计算高度。
- 预览区高度限制在 96px 到 320px。常见比例完整匹配；极端长图或宽图使用 `object-contain`，通过留白保留完整画面，不裁切主体。
- 无素材、授权失败、尺寸无效或图片加载失败时继续使用 144px 默认卡片，避免空状态抖动。
- XYFlow 节点高度和有边节点的 Handle 中点使用同一计算结果，保证连线随节点高度更新。节点位置不自动重排。

## Canvas Agent 上下文

- 在主进程内部的单次 `AgentRunExtensions` 增加可选系统上下文追加字段，不经过 Renderer IPC，不写入用户消息或会话 JSONL。
- Canvas 发送入口根据已经完成归属校验的 `projectId + canvasId + nodeId + title` 构建上下文，明确：
  - 当前会话已是 Canvas 内的 Agent 节点；
  - 不得要求用户创建、打开或切换到另一个 Design/Canvas；
  - 当前只读工具可用于理解项目和整理设计方案；
  - 当前运行没有直接修改 Canvas 图结构或执行生图的工具时，不得伪造已创建节点，只应给出可供当前画布继续使用的明确产出。
- 普通 Agent 的视觉意图分流规则保持不变；Design Job 和其他内部会话不接收此上下文。

## 影响与性能

- 共享类型、主进程预览构造、Renderer 投影和卡片展示需要同步修改；不增加依赖或额外 IPC 调用。
- 每个已采用素材仅增加两个整数，投影仍为单次 O(n)；图片解码次数不变。
- 每轮 Canvas Agent 仅增加一段常量级系统上下文，不增加模型调用次数。
- Agent、文档、原型节点的尺寸和交互保持不变。

## 错误与降级

- 非有限数、零值或负数尺寸视为无效，回退默认卡片。
- 预览 URL 授权或图片加载失败不阻断 Canvas LOAD。
- Canvas Agent 归属验证失败时沿用当前 fail-closed 行为，不构建上下文、不启动运行。

## 验证

- BDD 测试覆盖横图、竖图、极端比例、无效尺寸和无预览回退。
- 测试覆盖预览 IPC 保留宽高、节点投影同步高度及 Handle 中点。
- 测试覆盖 Canvas Agent 运行收到场景系统上下文，同时用户可见消息保持原文。
- 运行相关 Bun 测试与全仓 `bun run typecheck`，再在 Electron Canvas 中检查横图、竖图和 Agent 回复。
