# PromaDev 开发运行身份设计

## 结论

Proma 保持正式版与直接开发启动两套独立身份。正式打包版继续使用 `Proma` 与 `com.bone.proma.app`；未打包的直接启动实例显示为 `PromaDev`，继续使用 `com.bone.proma.dev`。

指定 `PROMA_DEV_INSTANCE` 时，开发实例显示为 `PromaDev - <instance>`。开发版继续使用独立的 Electron `userData` 与单实例锁，但与正式版共享 `~/.proma` 业务配置。

## 边界

- 不修改 `apps/electron/package.json` 的 workspace 包名，避免影响 Bun workspace 过滤和上游合并。
- 不新增开发版安装包或第二套发布流水线；本次只调整直接启动的运行时名称。
- 不修改正式版 Electron Builder 的 `Proma` 产品名和 `com.bone.proma.app` 标识。
- 不迁移现有开发版 `userData`，目录名继续为 `@proma/electron-dev`。

## 影响

用户可以在 Dock、任务栏、系统菜单和进程界面中用 `PromaDev` 识别直接启动的开发客户端，同时正式客户端仍显示为 `Proma`。改动只发生在启动期常量解析，不增加网络、磁盘或后台资源开销。

## 验收

- 打包环境解析为 `Proma / com.bone.proma.app`。
- 默认开发环境解析为 `PromaDev / com.bone.proma.dev`。
- 多工作树开发环境解析为 `PromaDev - <instance>`，实例清理和 `userData` 隔离保持不变。
- 身份测试、Electron typecheck 与构建通过。
