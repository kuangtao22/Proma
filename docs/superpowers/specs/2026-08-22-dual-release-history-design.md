# 关于页双版本历史设计

## 目标

在「关于/更新」页面同时展示 Proma fork 修改版本与官方 Proma 版本历史，并通过 Tabs 切换查看。版本历史仅用于阅读；自动检查、下载和安装更新始终以 fork 发布的 Bone 版本为准。

## 数据边界

- `Proma 修改`：读取 `kuangtao22/Proma` 的 GitHub Releases，仅保留标签符合 `v<官方版本>-bone.<构建号>` 的非草稿版本。
- `官方版本`：读取 `ErlichLiu/Proma` 的 GitHub Releases，仅保留普通正式 SemVer 标签，不展示草稿和预发布版本。
- `getLatestRelease`、`getReleaseByTag` 和 Electron Updater 保持指向 fork，不接受历史标签页传入的数据源，防止官方 Release 进入更新流程。

## 架构

在共享 GitHub Release 查询选项中增加受限的历史来源类型。现有 `LIST_RELEASES` IPC 继续作为唯一列表入口，默认来源为 `bone`，保证旧调用行为不变。

主进程 Release 服务维护两个固定仓库配置，并按来源分别缓存列表。Renderer 无权提交任意 owner/repo，只能选择 `bone` 或 `official`，避免把 IPC 扩展成通用网络代理。

`VersionHistory` 继续复用现有 Release 列表、折叠详情和 `ReleaseNotesViewer`。组件新增受控 Tabs：默认显示 `Proma 修改`，首次切换到另一标签时才加载对应数据；刷新按钮只刷新当前来源。

## 界面与状态

- Tabs 使用现有 Radix/shadcn `Tabs`、`TabsList`、`TabsTrigger` 和主题变量。
- 两个标签分别保存 releases、loading、error 和 expanded 状态，切换标签不会丢失已加载内容或展开状态。
- 每个来源默认展示最近 3 个符合条件的 Release，延续当前信息密度。
- 加载、空状态、错误提示和刷新操作保持现有视觉语言；错误只影响当前标签。
- Release 标题、发布日期、最新标记和展开日志沿用当前布局；“最新”表示当前来源列表中的最新版本。

## 更新隔离

自动更新不读取 `VersionHistory` 状态。`electron-updater` 继续读取 fork Release 中的 `latest-mac.yml`、`latest.yml` 和 `latest-linux.yml`，并允许 Bone 预发布 SemVer。关于页检测到更新后，仍只按 Bone 标签调用 fork 的 `getReleaseByTag`。

## 错误与性能

GitHub 限流冷却继续全局共享，但缓存按来源隔离，避免官方历史覆盖 Bone 历史。标签采用懒加载，因此首次打开关于页只产生一次 fork 请求；用户切换官方标签后才增加一次官方请求。过滤和缓存均为小列表上的常数级操作，不增加常驻后台任务。

## 测试与验收

- BDD 测试覆盖 Bone 标签过滤、官方正式标签过滤、两个来源缓存隔离和默认 Bone 来源。
- Renderer 测试覆盖默认标签、切换后调用官方来源、刷新当前来源，以及各标签独立的加载/错误状态。
- 发布合同测试继续证明 `autoUpdater.allowPrerelease = true`，更新仓库仍为 fork，官方数据源不进入更新器。
- 运行相关测试、全仓类型检查和 Electron 构建；界面在深浅主题下使用现有设置页样式且无布局溢出。

## 非目标

- 不合并两条版本线，不计算官方版本与 Bone 版本的对应关系。
- 不从官方仓库下载或安装应用。
- 不增加分页、搜索、版本对比或本地持久化历史。
