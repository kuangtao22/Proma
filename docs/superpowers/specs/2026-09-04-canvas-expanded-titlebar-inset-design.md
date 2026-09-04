# Canvas 展开态跨平台标题栏下移设计

## 目标

Canvas 展开到全窗口后，整条画布导航栏必须位于系统标题栏下方，不再与 macOS 红黄绿窗口按钮或 Windows 自绘窗口控制按钮共用同一垂直区域。

## 行为规则

1. 仅 Canvas 展开态启用顶部安全区；普通右侧 Pane、launcher 和非 Canvas 工作区保持现状。
2. macOS 顶部预留 `40px`，覆盖 `trafficLightPosition: { x: 18, y: 18 }` 对应的原生窗口按钮与必要间距。
3. Windows 顶部复用现有 `WINDOW_TITLEBAR_HEIGHT_PX = 32`，为最小化、最大化和关闭按钮保留完整区域。
4. Linux 不增加 Renderer 内标题栏安全区，继续使用系统原生标题栏布局。
5. 画布列表入口、可编辑标题、删除、展开/还原和回收区组成的整条导航栏统一下移，不拆分左右两组位置。
6. 顶部安全区保持 `titlebar-drag-region`，导航栏和画布交互区保持可点击、可拖动画布的现有语义。
7. 还原 Canvas 后立即移除顶部安全区，右侧 Pane 尺寸与导航位置恢复原状。

## 方案选择

采用“展开容器平台安全区”方案：由 `CanvasWorkspaceAdapter` 识别当前平台和展开状态，在全屏容器顶部插入明确高度的拖拽区，并让整个工作区在该安全区之后布局。

不采用仅给导航栏增加 `margin-top` 的方案，因为它不会同步收缩画布主体高度，容易产生纵向溢出，也无法形成完整的窗口拖拽区域。

不采用把 Canvas 导航 Portal 到全局标题栏的方案，因为这会扩大跨组件状态同步，并增加 ReactFlow 工作区重挂载或宿主身份漂移的风险。

## 层叠关系

Canvas 展开态仍需要越过 AppShell 的 `z-[60]` / `z-[61]` 栏位边界，但 Windows `WindowControls` 的 `z-[100]` 必须位于展开 Canvas 之上。因此：

- AppShell 右栏展开宿主使用高于 `61`、低于 `100` 的层级，建议固定为 `90`。
- `SidePanel` 在右栏宿主内部继续高于边界线和拖拽手柄。
- Canvas 自身的局部层级继续只处理画布内部工具栏、节点和浮层，不承担跨祖先层叠上下文职责。

这同时保留上一轮“全屏不显示 AppShell 分隔线”的修复，并让 Windows 窗口控制按钮重新处于可见、可点击的最上层。

## 组件边界

- `window-titlebar-layout.ts` 持有跨平台标题栏尺寸与纯布局决策，避免在 Canvas 组件内散落平台常量。
- `CanvasWorkspaceAdapter` 只消费布局决策，渲染展开态安全区并保持现有 Canvas 身份和视图状态。
- `NativeCanvasWorkspace` 与 legacy `DesignWorkspaceView` 继续复用同一 Adapter 外层安全区，不分别实现平台分支。
- `WindowControls` 不改变按钮尺寸、IPC 或交互行为。

## 数据与状态

不新增 Jotai atom、IPC、持久化字段或主进程状态。布局只由三个既有事实派生：

`isExpanded + isMac + isWindows -> 顶部安全区高度与 class`

平台判断在组件挂载时稳定计算；展开切换只改变布局 class，不重建 Canvas controller、ReactFlow graph、视口、选区或工作台状态。

## 错误与边界

- 平台无法识别时按 Linux/其它平台处理，不额外留白。
- 窗口缩放、最大化和高 DPI 不改变逻辑像素安全区；Windows 控制区继续由现有统一标题栏负责。
- 标题过长仍使用现有截断和原地编辑行为，不因下移改变宽度分配。
- Canvas 分屏状态下任一 Pane 展开时，外层右栏只提升一次；还原后恢复原层级。

## 关联影响

- 影响范围：Canvas 展开态、AppShell 右栏层叠关系和 Windows 全局窗口控制按钮。
- 不影响：普通右侧工作区、聊天主区、Canvas 图数据、节点运行、标题保存、删除、归档、回收区和画布列表。
- 性能：仅增加常数级平台判断、一个展开态拖拽区 DOM 和 CSS class 切换；没有监听器、轮询、磁盘 I/O 或网络请求。

## 测试与验收

1. 纯函数测试覆盖 macOS 展开 `40px`、Windows 展开 `32px`、Linux/其它平台 `0px` 及未展开 `0px`。
2. Adapter 回归测试确认只有展开态渲染安全区，并保持同一 `sessionId + projectId + canvasId`。
3. 层叠合同测试确认右栏展开宿主高于 AppShell 分隔线且低于 Windows `WindowControls`。
4. 运行 Canvas 相关定向测试、`bun run typecheck` 与 `bun run electron:build`。
5. macOS 客户端实测展开/还原：红黄绿按钮不遮挡导航，顶部可拖动窗口，原分隔线不穿透画布。
6. Windows 分支通过纯函数与层叠合同自动验证；可用 Windows 环境时补充窗口按钮点击和最大化视觉冒烟。
