# Proma Bone 版本与应用身份整理设计

## 结论

Proma fork 采用“官方版本 + Bone 构建号”的标准 SemVer，并让开发版与正式版拥有不同的系统身份。下一次发布使用应用版本 `0.17.42-bone.5`、Git 标签 `v0.17.42-bone.5` 和 Release 标题 `Proma 0.17.42 · Bone 5`。

正式版保持 `Proma` 与 `com.bone.proma.app`；开发版固定为 `Proma Dev` 与 `com.bone.proma.dev`，多工作树实例显示为 `Proma Dev - <instance>`。两者隔离 Electron 内部 `userData` 和单实例锁，但继续共享 `~/.proma` 中的 Skills、模型、渠道、会话与 LAN 配置。

## 问题

当前 Git 标签能区分 `v0.17.42-bone.1` 与 `v0.17.42-bone.4`，但应用版本和安装包仍只有 `0.17.42`。因此存在以下问题：

- 不同 Bone Release 的安装包文件名相同，下载后会覆盖或混淆。
- “关于”页面只能显示 `0.17.42`，无法确认实际构建。
- `electron-updater` 按应用 SemVer 比较版本，同一 `0.17.42` 下的 Bone Release 不会触发更新。
- 默认开发实例仍显示为 `Proma`，与正式版在 Dock、任务栏和系统进程列表中不易区分。
- 发布工作流未强制校验 Git 标签与应用版本一致，错误配置会在多个平台重复生成。

## 已确认方案

采用标准预发布 SemVer：

- 官方基线：`0.17.42`
- Bone 应用版本：`0.17.42-bone.5`
- Git 标签：`v0.17.42-bone.5`
- Release 标题：`Proma 0.17.42 · Bone 5`

后续同一官方基线上的 fork 发布递增 Bone 构建号，例如 `0.17.42-bone.6`。合入新官方版本后重置 Bone 构建号，例如 `0.17.43-bone.1`。

不采用以下方案：

- 继续使用应用版本 `0.17.42`：无法支持 Bone 版本自动更新。
- 使用 `0.17.42005` 等数字编码：虽然可以比较大小，但用户无法直观看出官方版本与 fork 构建号。
- 只在文件名附加 Bone 标签：只能解决下载辨识，不能解决应用内识别和自动更新。

## 版本来源与解析

`apps/electron/package.json` 的 `version` 是发布版本的唯一事实来源。构建、安装包、更新元数据和应用运行时均从该字段获得完整版本，不再维护第二份手写 Bone 版本。

增加一个小型纯函数模块解析 Bone SemVer，输出：

- `fullVersion`：完整版本，例如 `0.17.42-bone.5`。
- `upstreamVersion`：官方基线，例如 `0.17.42`。
- `boneBuild`：Bone 构建号，例如 `5`。

解析器只接受 `x.y.z-bone.n` 作为 fork 发布格式。开发环境可以读取同一版本并额外展示开发身份，不伪造另一个版本号。

## 正式版与开发版身份

### 正式版

- 显示名称：`Proma`
- 系统应用标识：`com.bone.proma.app`
- Electron Builder 产品名：`Proma`
- Electron `userData`：沿用正式打包版默认目录
- 业务配置目录：`~/.proma`

### 开发版

- 默认显示名称：`Proma Dev`
- 系统应用标识：`com.bone.proma.dev`
- 指定 `PROMA_DEV_INSTANCE` 时显示：`Proma Dev - <instance>`
- Electron `userData`：默认 `@proma/electron-dev`，实例模式为 `@proma/electron-dev-<instance>`
- 业务配置目录：仍为 `~/.proma`

主进程在任何读取 `userData`、申请单实例锁或创建窗口之前应用开发身份。Windows 同步设置开发版 App User Model ID；macOS 和 Linux 使用 Electron 开发运行时可控制的应用名称。正式安装包继续完全由 Electron Builder 的正式配置生成，不把开发名称写入 Release 产物。

## 安装包命名

所有平台文件名必须包含完整 Bone 版本、平台和架构：

- macOS Apple 芯片：`Proma-0.17.42-bone.5-macos-arm64.dmg`
- macOS Intel：`Proma-0.17.42-bone.5-macos-x64.dmg`
- Windows x64：`Proma-0.17.42-bone.5-windows-x64.exe`
- Linux AppImage：`Proma-0.17.42-bone.5-linux-x64.AppImage`
- Linux deb：`Proma-0.17.42-bone.5-linux-amd64.deb`

ZIP、blockmap 与更新元数据引用的路径必须同步使用实际产物名。命名由 Electron Builder 的平台配置生成，Release 汇总任务不进行容易与更新元数据漂移的二次重命名。

Linux 的 Electron Builder 架构名可能为 `x64`、`x86_64` 或 `amd64`，配置与合同测试以各目标实际支持的宏输出为准，但最终用户可见文件名必须明确平台和架构。

## GitHub Release 工作流

发布工作流增加前置版本合同校验：

1. 读取 `apps/electron/package.json` 的完整版本。
2. 校验版本满足 `x.y.z-bone.n`。
3. 校验触发标签严格等于 `v${version}`。
4. 校验开发版名称和标识未进入正式 Builder 配置。
5. 校验各平台 Artifact 与 Release 汇总任务使用统一命名规则。

任一校验失败时，在启动四个平台的大型构建前直接失败，减少无效 runner 时间和存储开销。

Release 标题从完整版本解析为 `Proma <upstreamVersion> · Bone <boneBuild>`。标签仍保留完整 SemVer，便于 Git、自动化工具和用户同时识别。

## 应用内显示与自动更新

“关于”页面将版本拆成两个明确字段：

- 官方版本：`0.17.42`
- Bone 构建：`5`

更新提示继续显示完整版本，例如 `发现新版本 0.17.42-bone.6`。LAN Bridge 的 `serverVersion`、浏览器 User-Agent 和诊断日志继续使用完整版本，便于定位具体构建。

`electron-updater` 启用预发布版本更新，使 `bone.5` 能发现 `bone.6`，并在官方基线提升后发现 `0.17.43-bone.1`。开发环境仍不初始化自动更新。

当前已发布的纯 `0.17.42` 在 SemVer 顺序中高于 `0.17.42-bone.5`，无法自动迁移。用户需要手动安装一次 `bone.5`；之后 Bone 版本可正常递增更新。应用不启用全局降级更新，避免为了这次迁移放宽长期安全边界。

## 历史 Release 整理

本次代码改动不自动删除历史 Release、草稿或 Git 标签。删除 `v0.17.42-bone.2`、`v0.17.42-bone.3` 等失败构建标签，以及旧 `v0.9.x` 草稿，属于不可逆的外部仓库操作，必须在新 Release 验证成功后单独列出精确对象并获得确认。

保留已成功发布的 `v0.17.42-bone.1` 与 `v0.17.42-bone.4` 作为迁移记录；GitHub 页面从 `bone.5` 起使用统一标题和安装包命名。

## 代码边界

预计修改范围：

- `AGENTS.md`：先更新版本约束，允许完整 Bone SemVer，同时要求记录官方基线。
- `MEMORY.md`：记录新版本与应用身份决策。
- `apps/electron/package.json`：应用版本升级到 `0.17.42-bone.5`。
- `apps/electron/electron-builder.yml`：正式身份与跨平台产物命名合同。
- `apps/electron/src/main/index.ts` 及小型身份模块：开发版名称、系统标识和 `userData`。
- `apps/electron/src/main/lib/updater/auto-updater.ts`：预发布更新设置。
- `apps/electron/src/renderer/components/settings/AboutSettings.tsx` 及版本解析模块：双版本显示。
- `.github/workflows/release.yml`：版本前置校验和 Release 标题。
- 对应测试文件：先锁定版本解析、身份解析、工作流合同和设置页显示。

不修改 LAN 认证、设备凭证、移动端协议、Agent Runtime、会话持久化或 `~/.proma` 路径。

## 测试与验收

### 自动化测试

- 版本解析测试覆盖合法 Bone 版本、不同官方基线和非法格式。
- 应用身份测试覆盖正式版、默认开发版、合法实例名和清理后的非法实例名。
- Release 合同测试覆盖标签与 package version 一致性、四平台命名、正式/开发身份隔离和 Release 标题。
- 更新器测试或静态合同确认预发布更新已开启，开发环境仍禁止更新。
- “关于”页面测试确认官方版本与 Bone 构建分别展示。
- 运行相关 Bun 测试、全 workspace typecheck、Electron build 和 fork 兼容检查。

### 发布验收

- 推送 `v0.17.42-bone.5` 后，版本合同任务先通过。
- macOS arm64/x64、Windows x64、Linux x64 和 Release 汇总任务全部成功。
- GitHub Release 标题、标签和所有安装包文件名可明确区分 Bone 5。
- `latest-mac.yml`、`latest.yml`、`latest-linux.yml` 的版本与下载路径和实际资产一致。
- 正式版系统显示为 `Proma`，开发版系统显示为 `Proma Dev`，两者可以同时运行。
- 两者继续读取同一个 `~/.proma` 业务目录。

## 关联模块与兼容性影响

- 完整版本会进入 LAN `serverVersion`、User-Agent、更新提示和诊断日志；这些字段已按字符串处理，不应假设只有三段数字。
- 修改 package version 会改变更新元数据和文件名，不改变配置 schema、会话格式或移动端协议版本。
- 开发版 App User Model ID 只影响系统身份、通知归属和任务栏分组，不改变正式安装包。
- 后续合并官方版本时只需更新官方基线并将 Bone 构建重置为 1，现有发布合同会阻止漏改标签。

## 性能与资源影响

- 版本与身份解析均为启动期常量操作，不增加后台任务、网络请求或持久化写入。
- 前置版本校验会减少错误发布触发的多平台 runner 消耗。
- 安装包体积、应用启动关键路径和运行时内存没有可感知变化。

## 非目标

- 不在本轮删除历史 Release、草稿或标签。
- 不改变 `~/.proma` 业务数据共享策略。
- 不新增第二套开发版安装包发布流水线。
- 不修改官方 Proma 的产品品牌素材。
- 不通过允许降级绕过首次 Bone SemVer 迁移。
