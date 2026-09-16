# 视频卡片沿用图片比例规则

用户要求：视频节点卡片与图片节点一样按素材比例显示。

## 最终行为

- 固定卡宽 288，标题栏 48；预览高度按 `288 × height / width` 计算，沿用图片的 96–320 上下限。16:9 视频总高 210，竖屏总高最多 368；使用 contain 完整呈现视频，不拉伸。
- 从已有媒体模块 LOAD 的资产元数据精确匹配已采用主视频的 assetId/revision/hash，只缓存两个尺寸数字；不新增预览请求、素材扫描、轮询或依赖。
- 缺失/非法元数据不继承其它素材比例，显示 144 空卡高度；主进程或新增位置无法确认比例时按 368 保守避让。
- 完整/增量投影同步卡片、XYFlow height/measured.height、Handle 中点；详情锚点、可见范围、导航和整理共享同一尺寸规则。
- Workspace 视频高度索引只随实际高度变化更新。普通进度、同尺寸采用切换、平移缩放不会重建全图尺寸索引。
- 主进程创建产物与审核 Agent 定位都避让视频最大预览高度，不直接修改真实画布位置或历史布局。
- 上轮已采用首帧预览、暂停静音、离屏及卸载释放资源的行为保留。

## 修改范围

Renderer 的进度投影、节点尺寸模型、Graph 详情几何、Workspace 布局/导航及相关测试；视频卡片说明注释；主进程产物创建和审核布局；现有真实 Electron 视频卡片 smoke。

本轮没有新增 IPC、修改默认 Skill、替换安装版、提交 Git 或运行真实媒体生成。

## 验证证据

- 元数据投影回归先 2 fail，修复后通过，覆盖横竖比例、非法尺寸、资产 hash 不匹配、采用切换和移除。
- 审核 Agent 布局回归先 2 fail，修复后 9 pass，覆盖竖视频障碍与邻接范围。
- 8 个相关文件 `bun test --isolate`：314 pass / 0 fail / 909 assertions。`/private/tmp/proma-video-ratio-tests.log`。
- 全仓 7 workspace 类型检查通过：`/private/tmp/proma-video-ratio-typecheck.log`。
- main/renderer 独立临时构建通过：`/private/tmp/proma-video-ratio-build`，日志分别为 `/private/tmp/proma-video-ratio-main-build.log` 和 `/private/tmp/proma-video-ratio-renderer-build.log`。
- 真实 Electron + NativeCanvasGraph：横屏210、竖屏368、缺失尺寸144；卡片矩形、Handle 中点与 edge path 起点一致；首帧可解码、不自动播放；采用切换、进度去重、迟到响应、离屏/卸载释放、读取/解码错误通过。日志 `/private/tmp/proma-video-ratio-smoke.log`。
- 截图 `/private/tmp/proma-video-card-dark.png`、`/private/tmp/proma-video-card-portrait.png`、`/private/tmp/proma-video-card-light.png`。

独立代码复审 APPROVE，无阻塞问题；`git diff --check` 通过。

真实浏览器测试使用内存录制 WebM 与内存 Adapter，不能代替用户实际项目或所有编码格式的验证。客户端需加载新 renderer/main 构建生效。
