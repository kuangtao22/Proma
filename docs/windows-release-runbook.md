# Windows 发布操作记录

更新日期：2026-09-07。适用于 Proma Bone 的 Windows x64 发布。

最省返工的路径是：版本与发布说明准备好后固定提交，在 Windows runner 上完成独立预检，再给同一提交打正式标签。保留行为测试，把冷编译的时间预算单独管理，避免用正式发布反复试错。

## 1. 固定提交，先跑独立 Windows 构建

待验证提交必须已推送到 `kuangtao22/Proma`，并包含最终版本号、发布说明和相关修复。从仓库根目录执行：

```bash
# 保存本轮待发布的完整提交 SHA；预检通过后，标签也必须指向它。
WINDOWS_RELEASE_SHA="$(git rev-parse HEAD)"
gh workflow run build-windows.yml --repo kuangtao22/Proma --ref main -f ref="$WINDOWS_RELEASE_SHA"
gh run list --repo kuangtao22/Proma --workflow build-windows.yml --event workflow_dispatch --limit 5 --json databaseId,status,conclusion,createdAt,url
```

`--ref main` 选择工作流定义，`-f ref=...` 决定实际检出的源码；后者必须显式填写。当前工作流输入的默认值仍是旧分支 `feat/lan-bridge-mobile`，直接使用默认值会验证错误的代码。

从本次触发记录取得 run ID，核对 Checkout 日志里的提交与 `WINDOWS_RELEASE_SHA` 一致。不能只凭 Actions 展示的工作流分支或 `headSha` 判断实际构建源码。

```bash
# 将占位内容替换为本次独立 Windows 构建的 run ID。
WINDOWS_RUN_ID='<本次 run ID>'
gh run watch "$WINDOWS_RUN_ID" --repo kuangtao22/Proma --interval 30 --exit-status
```

预检通过要求：原生测试、资源准备、打包和 `Proma-win-x64` 产物上传全部成功；记录跳过用例及原因。当前独立工作流只上传 `.exe`，更新 YAML 和其他平台产物仍须在正式 Release 验收。

预检后只要待发布源码、依赖、打包配置或版本发生变化，就重新固定提交并验证。正式标签严格等于 `v${apps/electron/package.json.version}`，且指向通过预检的提交。预检可提前发现问题，正式 Release 仍需成功完成自身的构建。

## 2. 沿用已验证的工具链与顺序

截至本记录，工具链为 Bun `1.3.14`、Node `22`、node-gyp `12.4.0`、Electron Builder `25.1.8`；升级时重新验证，避免临时使用 `latest`。Node 目前只固定主版本，`windows-latest` 镜像也会更新，因此仍需保留每次构建日志。

现有工作流顺序：

1. `bun install --frozen-lockfile`，保留完整开发依赖。
2. 执行 stable-directory host 与构建脚本的定向测试。
3. 使用 `package:prepare:win`：Electron 构建、移动端构建、重建 `node-pty`、安装 Windows 目标依赖、同步 runtime 依赖。
4. 在 `apps/electron` 中执行 `bun run builder --win --x64 --publish never`，再上传产物。

Windows 目标依赖安装命令为 `bun install --frozen-lockfile --os=win32 --cpu=x64`，runtime 同步必须检查 `@img/sharp-win32-x64`。测试和 `node-pty` 重建需要完整开发依赖，必须早于 runtime 目录精简；否则可能出现 `electron` 无法解析或重建失败。

优先使用 `windows-latest` 执行完整链路。macOS 的编译成功无法覆盖 C++ 的 `_WIN32` 分支；仅安装 Windows Sharp 依赖，也不能证明 CLI、原生 helper 和 PTY 都生成了可用的 Windows 产物。

源码入口：[独立工作流](../.github/workflows/build-windows.yml)、[正式发布工作流](../.github/workflows/release.yml)、[打包脚本](../apps/electron/package.json)。

## 3. 编译时间与行为测试分开

`stable-directory-native-host.test.ts` 在文件级只编译一次 helper，当前编译子进程超时为 120 秒，`beforeAll` 上限为 150 秒，给异常收尾留出余量；各项行为测试保持原有超时。

编译输出使用 `stdio: 'inherit'`，同时保留 stdout 和 stderr。MSVC 会把编译错误写到 stdout，捕获后不输出会让 CI 只剩笼统的子进程失败信息。

这来自两次不同故障：

| 版本 | 证据与原因 | 对应处理 |
| --- | --- | --- |
| `bone.8` | Windows 原生代码调用不存在的 `WindowsVolumeId` | 修复 Windows 分支，读取现有 `identity.dwVolumeSerialNumber`，保留编译诊断 |
| `bone.9` | 独立构建成功，正式构建约 30026ms 时被旧 30 秒 hook 截止 | 编译独立限时 120 秒、hook 150 秒，保持行为测试约束 |

旧的“组级编译 30 秒足够”经验已失效。新的预算是超时上限，不会让正常编译额外等待，也没有客户端运行时开销。

源码入口：[原生测试准备](../apps/electron/src/main/lib/stable-directory-native-host.test.ts)、[Windows helper](../apps/electron/native/stable-directory/stable-directory-helper.cc)。

## 4. 按失败证据处理

先定位失败 job。整个 run 尚未结束时，可直接读取已完成 job 的日志：

```bash
gh run view "$WINDOWS_RUN_ID" --repo kuangtao22/Proma --json jobs
# 将占位内容替换为失败且已结束的 job ID。
WINDOWS_JOB_ID='<失败 job ID>'
gh api "repos/kuangtao22/Proma/actions/jobs/$WINDOWS_JOB_ID/logs"
```

| 现象 | 下一步 |
| --- | --- |
| MSVC 报未定义符号或类型错误 | 修复对应 Windows 分支，在 Windows runner 重验 |
| 编译仍进行时 hook 超时 | 核对实际耗时、子进程期限和 hook 上限，只调整有证据不足的准备预算 |
| 临时下载或服务网络失败 | 确认无源码问题后，重跑失败 job；保持工具版本固定 |
| 测试找不到 `electron`、PTY 重建失败 | 检查测试和重建是否错误地放在依赖精简之后 |
| Builder 成功，但启动找不到 Sharp | 解包核对 Windows `.node` 与 libvips DLL，并检查目标依赖安装和同步合同 |
| 安装后仍出现旧错误 | 核对实际 `app.asar` 版本、安装器和已安装文件的 SHA-256，排除旧目录、旧快捷方式或传错包 |
| `gh` 无权限，但 Git 可推送 | 分别核对 CLI 与 Git 的账号和授权；本次有写权限的账号为 `kuangtao22`，凭据存放于系统钥匙串，不输出令牌 |

已公开的失败标签保留；源码修复使用新 Bone 版本，不强制移动旧标签。

## 5. 发布验收与证据边界

正式发布完成后，核对四个平台构建、汇总 job、安装包和更新元数据。Windows 更新 YAML 的版本、引用文件、大小、SHA-512 应与实际资产对应；完整跨平台发布还需核对其他更新 YAML，以及 Release 正文与仓库说明一致。

安装启动另作验收：在 Windows 安装或升级，确认普通启动、数据根失效时的恢复入口、Sharp 加载、CLI 与终端可用。打包成功只能证明构建链路完成，不能直接写成安装启动或全部业务已验证。

本次成功基线：[v0.19.31-bone.10](https://github.com/kuangtao22/Proma/releases/tag/v0.19.31-bone.10)，源码 `ad19ee6c5740c415ab2c35d0e4a449a82132cb61`，[Release 工作流 34076461380](https://github.com/kuangtao22/Proma/actions/runs/34076461380) 全部成功，15 个资产齐全。既有验收核对了三个更新 YAML 的版本、文件存在性、大小、SHA-512 格式与 GitHub 提供的元数据 SHA-256；这不等于对所有安装包重算了 SHA-512，也不替代 Windows 安装启动和真实渠道业务验收。

本记录复用现有工作流，未新增自动预检门禁。后续若自动化，应把“指定 SHA 预检成功才允许发布同一 SHA”纳入发布入口，并共享 Windows 构建步骤，减少手动漏项和两个工作流的顺序漂移。
