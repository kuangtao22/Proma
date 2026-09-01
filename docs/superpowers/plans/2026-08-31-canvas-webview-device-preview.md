# Canvas WebView 设备预设与静态预览实施计划

> 依据：`docs/superpowers/specs/2026-08-31-canvas-webview-device-preview-design.md`

## 目标

让 WebView 节点使用持久化的 `desktop/mobile` 设备预设控制卡片外形和详情视口；卡片通过主进程离屏截图显示静态 WebP，不运行 iframe；切换设备不调用 Agent、不复制 HTML，并保持节点左上角位置不变。

## 约束与影响

- 保留当前工作区中上一阶段 WebView 内容加载与 sandbox 导航修复，不回滚、不拆分。
- IPC 必须同步 shared、main、preload、renderer 四层。
- 不新增依赖，不修改 README、教程或发布说明。
- 预览生成复用单个离屏 `BrowserWindow` 并串行执行；Renderer 只请求已挂载节点，避免大画布常驻网页运行时。
- 统一几何函数供卡片、碰撞、追加和子节点扩展使用，防止只有视觉尺寸变化而布局仍按旧常量计算。

## Task 1：Shared 合同、schema 迁移与 mutation

**文件**

- 修改：`packages/shared/src/types/canvas.ts`
- 修改：`packages/shared/src/types/canvas.test.ts`
- 修改：`apps/electron/src/main/lib/design/canvas-document-store.test.ts`

**TDD 步骤**

1. 先写 BDD 测试：
   - `desktop/mobile` 严格解析，未知值拒绝。
   - 新 schema 的 WebView 缺少 `devicePreset` 时拒绝。
   - 旧 schema 加载时确定性迁移为 `desktop`。
   - `set-webview-device-preset` 仅修改目标 WebView，未知节点或非 WebView 拒绝。
   - WebView 预览 target/snapshot 严格绑定项目、画布、节点、contentId、contentRevision 和预设。
2. 运行：`bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts`，确认新增场景红灯。
3. 实现 `CanvasWebviewDevicePreset`、schema 升级与迁移、mutation、preview target/snapshot/parser。
4. 重新运行同组测试，确认绿灯。

## Task 2：统一 WebView 设备几何

**文件**

- 修改：`apps/electron/src/renderer/components/design/native-canvas-model.ts`
- 修改：`apps/electron/src/renderer/components/design/native-canvas-model.test.ts`
- 修改：`apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`

**TDD 步骤**

1. 先写测试：desktop 卡片 `384 x 316`、mobile 卡片 `232 x 578`；左上角不随预设切换；碰撞、全局追加和子节点扩展使用动态矩形。
2. 运行：`bun test apps/electron/src/renderer/components/design/native-canvas-model.test.ts`，确认红灯。
3. 新增统一的节点尺寸/矩形函数，替换 WebView 相关固定宽高读取；保留图片节点现有比例逻辑。
4. 重新运行测试，确认绿灯。

## Task 3：主进程离屏预览服务与缓存

**文件**

- 新增：`apps/electron/src/main/lib/design/canvas-webview-preview-service.ts`
- 新增：`apps/electron/src/main/lib/design/canvas-webview-preview-service.test.ts`
- 复用：`apps/electron/src/main/lib/sandboxed-srcdoc-navigation.ts`
- 修改：`apps/electron/src/main/index.ts`

**TDD 步骤**

1. 先写测试：
   - 同一完整目标合并在途请求并命中缓存。
   - 不同 content revision 或设备预设生成不同缓存键。
   - 全局截图任务严格串行。
   - desktop/mobile 使用 `1440 x 900` 与 `390 x 844` 视口。
   - popup、网络、主 frame 与子 frame 外部导航均阻断。
   - dispose 后窗口和队列释放。
2. 运行定向测试并确认红灯。
3. 实现单窗口、串行队列、前置 CSP、sandbox、`capturePage`、WebP 原子缓存与生命周期清理。
4. 重新运行测试，确认绿灯。

## Task 4：预览 IPC 四层接线与授权

**文件**

- 修改：`packages/shared/src/types/canvas.ts`
- 修改：`apps/electron/src/main/lib/design/canvas-document-ipc.ts`
- 修改：`apps/electron/src/main/lib/design/canvas-document-ipc.test.ts`
- 修改：`apps/electron/src/main/ipc.ts`
- 修改：`apps/electron/src/preload/design-preload.ts`
- 修改：`apps/electron/src/preload/design-preload.test.ts`
- 修改：`apps/electron/src/renderer/lib/design-adapter.ts`
- 修改：`apps/electron/src/renderer/lib/design-adapter.test.ts`

**TDD 步骤**

1. 先写测试：完整公开字段透传、主窗口/项目/画布/节点授权、目标与权威节点不匹配拒绝、公开错误稳定、Renderer 同目标请求合并。
2. 运行四层定向测试并确认红灯。
3. 新增预览通道、handler、preload selector、adapter 方法；主进程从权威文档和内容 Store 重建目标后调用预览服务，不信任 Renderer 自报身份。
4. 重新运行测试，确认绿灯。

## Task 5：卡片预览、设备菜单与详情控制

**文件**

- 修改：`apps/electron/src/renderer/components/design/CanvasNodeCard.tsx`
- 修改：`apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx`
- 新增：`apps/electron/src/renderer/components/design/CanvasWebviewPreview.tsx`
- 新增：`apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx`
- 修改：`apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.tsx`
- 修改：`apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx`
- 修改：`apps/electron/src/renderer/components/design/NativeCanvasGraph.tsx`
- 修改：`apps/electron/src/renderer/components/design/NativeCanvasWorkspace.tsx`
- 修改：`apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`

**TDD 步骤**

1. 先写测试：
   - 卡片 loading/ready/error/retry；旧目标迟到结果丢弃。
   - 卡片只显示静态图片，图片不接收指针事件。
   - 设备按钮菜单提供网页/手机和视口尺寸。
   - 切换设备排入现有 mutation 保存队列，不调用 Agent，节点 position 不变。
   - 详情分段控制与同一字段同步；双击/放大打开详情的既有交互保持。
2. 运行组件测试并确认红灯。
3. 实现预览状态组件、设备菜单、动态卡片容器和详情 viewport。
4. 重新运行测试，确认绿灯。

## Task 6：Agent 创建默认值与批处理兼容

**文件**

- 修改：`apps/electron/src/main/lib/design/canvas-artifact-creation.ts`
- 修改：`apps/electron/src/main/lib/design/canvas-artifact-creation.test.ts`
- 修改：相关 Canvas tool schema/provider 测试（仅实际接口需要时）

**TDD 步骤**

1. 先写测试：Agent 显式 `mobile`/`desktop` 能创建对应节点；缺省为 `desktop`；Renderer 不做关键词判断。
2. 运行定向测试并确认红灯。
3. 扩展工具参数和节点构造，保持旧调用兼容默认 desktop。
4. 重新运行测试，确认绿灯。

## Task 7：回归验证与真实客户端验收

1. 运行全部相关 Canvas 测试：
   `bun test packages/shared/src/types/canvas.test.ts apps/electron/src/main/lib/design/canvas-document-store.test.ts apps/electron/src/main/lib/design/canvas-document-ipc.test.ts apps/electron/src/main/lib/design/canvas-webview-preview-service.test.ts apps/electron/src/preload/design-preload.test.ts apps/electron/src/renderer/lib/design-adapter.test.ts apps/electron/src/renderer/components/design/native-canvas-model.test.ts apps/electron/src/renderer/components/design/CanvasNodeCard.test.tsx apps/electron/src/renderer/components/design/CanvasWebviewPreview.test.tsx apps/electron/src/renderer/components/design/CanvasWebviewWorkbench.test.tsx apps/electron/src/renderer/components/design/NativeCanvasWorkspace.test.tsx`
2. 运行：`bun run typecheck`。
3. 运行：`bun run electron:build`。
4. 启动开发客户端，真实操作验证：创建 desktop/mobile WebView、静态缩略图、设备切换、节点原位、拖动/框选/缩放、双击详情、详情交互和预览失败恢复。
5. 检查 `git diff`，确认未提交 `.superpowers/`、未修改无关文件。
6. 将本次新增架构决策与踩坑补充到 `MEMORY.md`。

## 自审

- 规格覆盖：数据合同、迁移、离屏截图、安全、IPC、UI、几何、Agent 默认值、性能与真实客户端验证均有对应任务。
- 命名一致：沿用现有 `CanvasWebviewTarget/Snapshot`，新增预览命名统一为 `CanvasWebviewPreview*`，设备字段统一为 `devicePreset`。
- 占位符扫描：计划不包含未决 TODO、伪文件名或待选方案；实现时以仓库实际导出名为准做最小调整。
- 停止条件：相关测试、typecheck、Electron build 和真实客户端关键路径均通过，或明确报告无法执行的验证缺口。
