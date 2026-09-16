# 已采用视频卡片预览修复

用户反馈：已采用的视频没有在画布节点卡片上显示。

## 原因与行为

音视频进度此前仅输出 `hasAdoptedOutput`，Graph 直接渲染通用文字卡片，没有消费已采用视频身份。

现在已有模块 LOAD 将正式 adopted primary video 的候选、输出 key/order 和目标身份传给卡片。只显示当前采用素材，不回退未采用候选；自动首次采用和显式采用使用同一路径。重新生成的进度不会覆盖旧视频，采用切换或清除分别更新或移除预览。

专用 CanvasVideoNodePreview 保持原 288×144 卡片尺寸、标题、状态、展开按钮和手势。可视区域内只读取暂停、静音的首帧；IntersectionObserver 与 XYFlow 可见节点裁剪共同限制挂载。离屏、切换、取消采用、解码失败或卸载均清空 src/load 并释放 lease。迟到请求只释放，不覆盖新目标。Graph 稳定桥记录申请时的 release Adapter，保证热切换或移除能力后仍归还原所有者。

## 范围与性能

- 新增 `CanvasVideoNodePreview.tsx`。
- 修改 `use-media-run-progress.ts`、`native-canvas-model.ts`、`NativeCanvasGraph.tsx`、`NativeCanvasWorkspace.tsx` 及相应回归测试。
- 新增 `apps/electron/scripts/canvas-video-node-preview-smoke{.ts,-renderer.tsx,.html}` 可执行隔离验证。
- 不新增 IPC、依赖、轮询、素材扫描或视频生成；复用已有事件和受管预览接口。
- 相同采用身份的运行进度更新不重复申请预览。仅可见视频占用暂停解码器；未进行超大视频画布总内存基准测试。
- 前两轮未提交修改保留，未提交或推送本轮代码；未写入真实画布、运行收费生成或替换客户端 dist。

## 验证

1. 数据投影回归先失败：76 pass / 2 fail；接线后通过。
2. `bun test --isolate` 对进度、节点投影、性能、缩放、Workspace、卡片、媒体工作台、媒体服务共 8 个文件：**370 pass / 0 fail / 1076 assertions**。日志 `/private/tmp/proma-video-card-tests.log`。
3. `bun run typecheck`：7 workspace 通过。日志 `/private/tmp/proma-video-card-typecheck.log`。
4. Renderer 隔离构建通过，输出 `/private/tmp/proma-video-card-build`，日志 `/private/tmp/proma-video-card-build.log`；现有 Vite 大 chunk 提示保留。
5. 真实 Electron + NativeCanvasGraph smoke 通过：初始离屏零读取、首帧 readyState≥2/videoWidth=320、暂停/静音/无 controls、未采用不显示、进度去重、A→B、迟到读取、离屏/采用清除/卸载释放、读取失败不循环重试、解码失败释放、深浅主题。日志 `/private/tmp/proma-video-card-smoke.log`；截图 `/private/tmp/proma-video-card-dark.png`、`/private/tmp/proma-video-card-light.png`。
6. 独立审查 APPROVE，无阻塞发现；`git diff --check` 通过。

测试媒体是本地内存录制的有效 WebM，验证的是实际生产组件及预览生命周期，不代表所有编码格式或用户安装版已经实测。源码生效需客户端加载新 renderer 构建。

## 重复执行 UI 验证

在 `apps/electron` 中启动独立 Vite：

```sh
bun node_modules/vite/bin/vite.js --port 5193 --strictPort
bunx --no-install esbuild scripts/canvas-video-node-preview-smoke.ts --bundle --platform=node --format=cjs --external:electron --outfile=/private/tmp/proma-video-card-smoke.cjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron /private/tmp/proma-video-card-smoke.cjs
```

测试使用临时 Electron userData 和内存 Adapter，不访问真实业务服务。
