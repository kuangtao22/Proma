# Canvas Completion QA

该目录提供隔离 Electron `BrowserWindow` 的 Canvas 完成度验证。它加载真实 `NativeCanvasWorkspace`、Jotai、XYFlow 和生产样式，但使用专用 preload + 内存 IPC fixture，因此不会读取 `~/.proma`、Automation、模型或发布配置。

运行命令：

```bash
PROMA_CANVAS_QA_PLAYWRIGHT=/Users/xutaoyu/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright \
  node apps/electron/scripts/canvas-completion-qa/run.mjs
```

运行器默认按 Node 模块规则解析 `playwright`；本机 bundled runtime 使用上面的 `PROMA_CANVAS_QA_PLAYWRIGHT` 覆盖，不在脚本中绑定用户主目录。

独立类型检查：

```bash
bunx tsc --noEmit -p apps/electron/scripts/canvas-completion-qa/tsconfig.json
```

脚本在 `/tmp/proma-canvas-completion-qa-*` 输出截图与 `report.json`，覆盖：1000/3000 节点、两种规模各自独立的同序列交互帧 p95（门槛 33ms）与超过 100ms stall、12 条活动更新、5000 条主进程历史与有界活动 IPC、Sharp 生成的 320x200 本地 PNG 缩略图、宽窄/明暗主题、主机与刷新率信息，以及五轮挂载后的 DOM、preload IPC 监听器和 CDP V8 heap 回落。`performance.memory` 仅保留为环境信息，内存稳定结论使用 `HeapProfiler.collectGarbage` 与 `Runtime.getHeapUsage` 的逐轮样本。

该结果属于真实 Renderer 组件与隔离 IPC 的 Electron 集成 QA，不代表生产 App bootstrap、生产 IPC 注册或真实用户配置链路验收。
