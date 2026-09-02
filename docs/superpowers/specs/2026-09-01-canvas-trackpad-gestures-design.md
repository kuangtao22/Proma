# Canvas 触摸板手势设计

## 目标

让画布遵循桌面设计工具的输入习惯：触摸板两指滑动平移画布，双指捏合或张开缩放；鼠标滚轮平移，按 `Command/Ctrl` 加滚轮缩放。

## 交互合同

- 显式开启 XYFlow `panOnScroll`，让滚动手势驱动画布平移。
- 关闭 `zoomOnScroll`，避免两指滑动被误判为连续缩放。
- 保持 `zoomOnPinch`，由 XYFlow 原生识别触摸板捏合缩放。
- 保持 `preventScrolling`，画布区域内手势不穿透到外层页面。
- 节点选择、节点拖动、框选、手型工具、双击详情和现有缩放范围保持不变。
- 节点工作台继续使用 `nodrag nopan nowheel`，输入、列表和滚动条交互不会带动画布。

## 方案取舍

采用 XYFlow 原生配置，不通过 `wheel.deltaX/deltaY` 或浏览器平台特征猜测鼠标与触摸板。浏览器事件不能稳定区分普通滚轮和触摸板两指滚动，启发式判断容易在不同系统和设备上产生反向缩放、抖动或失效。

## 关联影响

改动只发生在 Renderer 的 Canvas Flow 属性，不修改画布文档、viewport 持久化格式、IPC 或 Agent 工具。视口仍沿用现有 `onMoveStart/onMove/onMoveEnd` 收敛逻辑，手势结束后只提交最终 viewport。

## 性能与资源

只调整 XYFlow 已有事件开关，不增加监听器、定时器、轮询、状态或 I/O。工作台的 `nowheel` 隔离避免内部滚动触发不必要的画布更新。

## 验证

- 回归测试验证 Flow 明确收到 `panOnScroll=true`、`zoomOnScroll=false`、`zoomOnPinch=true`、`preventScrolling=true`。
- 原有选择/手型工具测试继续通过，证明节点编辑语义未回退。
- 运行 Renderer 定向测试与全仓类型检查。
