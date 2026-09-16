# 空视频节点首次生成默认采用

用户要求：视频节点此前没有视频，生成完成后默认采用本次视频。

已有后端具备初次默认采用，但发现一个可复现的漏选路径：`CanvasMediaService.save` 对语义完全相同的配置仍增加配置版本；运行中的候选保留启动时版本，完成后被严格来源版本检查排除。采用检查本身必须保留，否则真正修改输入后旧结果会覆盖新要求。

修复复用现有保存与采用链路：对保存的 profile、workflow、preparation、inputs、outputs、保留的 adoptedOutputs 做语义比较，可选字段缺失与 null 等价；无变化直接返回隔离副本，不写盘或推进版本。实际变化仍使用原 CAS。视频工作台默认状态改为“已默认采用”，保留明确的“确认此版本”入口；默认初始化不替代质量评审，也不自动解除下游工作流的显式采用门禁。已有视频选择保持不变。

性能与兼容：仅增加有界配置的本地深比较，使用 Node 内置 util，不新增依赖、远端请求、轮询或媒体扫描；重复保存减少磁盘写入。保存调用方均使用返回的实际版本，真正的配置更新继续推进版本。音频沿用原采用规则。

验证：
- 7 文件定向回归 170 pass / 0 fail，499 assertions，日志 `/private/tmp/proma-video-initial-adoption-tests.log`。新增真实 Store 测试覆盖后台完成、相同配置保存不推进内外版本，以及实际修改提示词后保留旧候选但不默认采用。
- 7 workspace 类型检查通过，日志 `/private/tmp/proma-video-initial-adoption-typecheck.log`。
- main 与 renderer 隔离构建通过，产物 `/private/tmp/proma-video-initial-adoption-build/`；Renderer 仍有原大分块提示，未修改打包依赖。
- 真实 Electron 工作台冒烟通过：已默认采用标识、精确候选自动预览、手动切换、真实测试视频播放、保存/运行/取消/导出/采用、宽窄布局、错误状态及预览 lease 回收。日志 `/private/tmp/proma-video-initial-adoption-smoke.log`，截图 `/private/tmp/media-workbench-layout-wide-dark.png`。旧脚本对内部错误文本的断言已同步为现有生产公开错误提示；等待视频先核对当前 lease URL，修复误读上一预览 readyState 的测试竞态。
- `git diff --check` 通过。未触发真实媒体生成、修改真实业务数据、更新安装版或发布；需加载新构建生效。
