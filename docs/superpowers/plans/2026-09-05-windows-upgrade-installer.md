# Windows 原位升级提示 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Windows 安装器检测到现有 Proma Bone 时，明确展示旧版本和旧安装位置，并继续由 electron-builder 在用户选择的目标目录执行安全升级。

**Architecture:** 继续使用 electron-builder assisted NSIS 和稳定 `appId` 的既有注册表检测、旧版卸载及 `--updated` 数据保留语义。仅通过 `nsis.include` 注入一个 `customPageAfterChangeDir` 自定义摘要页，复用当前安装模式设置的 `SHELL_CONTEXT` 读取注册表值；没有旧安装路径时直接跳过该页。

**Tech Stack:** Bun test、Electron Builder 25、NSIS Modern UI、nsDialogs、YAML 配置。

---

## 文件结构

- `apps/electron/scripts/release-workflow.test.ts`：增加 Windows 安装器静态合同测试，锁定 include 接线、注册表读取、首次安装跳过、未知版本回退和完整性校验边界。
- `apps/electron/resources/installer.nsh`：定义升级摘要页变量、页面宏和创建函数；只负责展示，不接管安装、卸载或数据迁移。
- `apps/electron/electron-builder.yml`：通过 `nsis.include` 接入自定义 NSIS 片段。
- `MEMORY.md`：记录 Windows 原位升级的长期架构决策、用户影响和资源影响。

### Task 1: 锁定 Windows 升级安装器合同

**Files:**
- Modify: `apps/electron/scripts/release-workflow.test.ts`
- Test: `apps/electron/scripts/release-workflow.test.ts`

- [ ] **Step 1: 扩展 Electron Builder 配置类型并加入安装器文本读取函数**

在 `ElectronBuilderConfig` 中加入：

```ts
  /** Windows NSIS 安装器配置。 */
  nsis?: {
    /** 注入 electron-builder NSIS 模板的自定义 include。 */
    include?: string
  }
```

在 `readElectronBuilderConfig()` 后加入：

```ts
/** 返回 Windows 安装器自定义 NSIS include 文本。 */
function readWindowsInstallerInclude(): string {
  /** 当前测试脚本到 NSIS include 的路径。 */
  const includePath = resolve(import.meta.dir, '../resources/installer.nsh')
  return readFileSync(includePath, 'utf8')
}
```

- [ ] **Step 2: 写入会失败的 BDD 合同测试**

加入以下测试：

```ts
test('Windows 升级安装器展示既有版本和目录并保留完整性校验', () => {
  /** Electron Builder 的正式打包配置。 */
  const config = readElectronBuilderConfig()
  /** Windows 安装器自定义 NSIS include。 */
  const installerSource = readWindowsInstallerInclude()

  expect(config.nsis?.include).toBe('resources/installer.nsh')
  expect(installerSource).toContain('!macro customPageAfterChangeDir')
  expect(installerSource).toContain('ReadRegStr $upgradeInstallLocation')
  expect(installerSource).toContain('"${INSTALL_REGISTRY_KEY}" InstallLocation')
  expect(installerSource).toContain('ReadRegStr $upgradeDisplayVersion')
  expect(installerSource).toContain('"${UNINSTALL_REGISTRY_KEY}" DisplayVersion')
  expect(installerSource).toContain('StrCpy $upgradeDisplayVersion "未知版本"')
  expect(installerSource).toMatch(/\$upgradeInstallLocation == ""[\s\S]*Abort/)
  expect(installerSource).not.toContain('/NCRC')
})
```

- [ ] **Step 3: 运行测试并确认因功能文件缺失而失败**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: FAIL，`readFileSync` 报告 `apps/electron/resources/installer.nsh` 不存在，证明测试确实覆盖待实现功能。

- [ ] **Step 4: 提交红阶段测试**

```bash
git add apps/electron/scripts/release-workflow.test.ts
git commit -m "测试：锁定 Windows 原位升级安装器合同"
```

### Task 2: 实现只读升级摘要页

**Files:**
- Create: `apps/electron/resources/installer.nsh`
- Test: `apps/electron/scripts/release-workflow.test.ts`

- [ ] **Step 1: 新增自定义页面 include**

创建 `apps/electron/resources/installer.nsh`：

```nsis
# 保存检测到的旧安装目录，只用于升级摘要展示。
Var upgradeInstallLocation
# 保存检测到的旧版本号，注册表缺失时显示“未知版本”。
Var upgradeDisplayVersion

# 在安装目录页之后注册升级摘要页，由页面创建函数决定是否跳过。
!macro customPageAfterChangeDir
  Page custom createUpgradeSummaryPage
!macroend

# 延后定义页面函数，确保 electron-builder 已加载 MUI、nsDialogs 与注册表上下文。
!macro customHeader
  # 按 electron-builder 已选定的安装作用域读取旧安装信息并创建只读摘要页。
  Function createUpgradeSummaryPage
    StrCpy $upgradeInstallLocation ""
    StrCpy $upgradeDisplayVersion ""

    ReadRegStr $upgradeInstallLocation SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
    ReadRegStr $upgradeDisplayVersion SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion

    ${If} $upgradeInstallLocation == ""
      Abort
    ${EndIf}
    ${If} $upgradeDisplayVersion == ""
      StrCpy $upgradeDisplayVersion "未知版本"
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "升级现有 Proma" "确认旧版本与本次安装位置"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}

    ${NSD_CreateLabel} 0 0 100% 24u "检测到已安装版本：Proma $upgradeDisplayVersion"
    Pop $1
    ${NSD_CreateLabel} 0 28u 100% 36u "旧安装位置：$upgradeInstallLocation"
    Pop $1
    ${NSD_CreateLabel} 0 68u 100% 36u "本次安装位置：$INSTDIR"
    Pop $1
    ${NSD_CreateLabel} 0 112u 100% 42u "继续后将先卸载旧版本，保留本地业务数据与快捷方式，再安装 Proma ${VERSION}。"
    Pop $1

    nsDialogs::Show
  FunctionEnd
!macroend
```

- [ ] **Step 2: 运行测试并确认仅剩配置接线失败**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: FAIL，失败项只剩 `config.nsis?.include` 为 `undefined`；NSIS include 的内容合同通过。

- [ ] **Step 3: 检查 include 不包含安装、卸载或校验绕过逻辑**

Run: `rg -n "uninstallOldVersion|File /r|SetOutPath|/NCRC" apps/electron/resources/installer.nsh`

Expected: 没有输出。页面只读取注册表并展示信息，不复制 electron-builder 的安装主流程。

### Task 3: 接入 Electron Builder

**Files:**
- Modify: `apps/electron/electron-builder.yml`
- Test: `apps/electron/scripts/release-workflow.test.ts`

- [ ] **Step 1: 配置 NSIS include**

在现有 `nsis:` 下加入：

```yaml
  # 复用 electron-builder 安装状态，只增加旧版本与安装位置摘要页。
  include: resources/installer.nsh
```

- [ ] **Step 2: 运行定向测试并确认通过**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: PASS，全部发布工作流与安装器合同测试通过。

- [ ] **Step 3: 提交实现**

```bash
git add apps/electron/resources/installer.nsh apps/electron/electron-builder.yml
git commit -m "修复：Windows 升级安装时显示旧版本与目录"
```

### Task 4: 验证配置、类型与 Windows 打包边界

**Files:**
- Modify: `MEMORY.md`
- Test: `apps/electron/scripts/release-workflow.test.ts`

- [ ] **Step 1: 运行定向测试**

Run: `bun test apps/electron/scripts/release-workflow.test.ts`

Expected: PASS，无错误或警告。

- [ ] **Step 2: 运行全仓类型检查**

Run: `bun run typecheck`

Expected: exit 0。若失败，只处理由本任务引入的错误；已有用户改动导致的错误必须单独记录，不覆盖其文件。

- [ ] **Step 3: 运行 Electron 构建验证**

Run: `bun run electron:build`

Expected: exit 0，Renderer、Main、Preload 和 Utility Process 构建通过。

- [ ] **Step 4: 校验 Windows 打包配置可解析**

Run: `bunx electron-builder --config apps/electron/electron-builder.yml --dir --win nsis --x64`

Expected: 在 Windows runner 上生成 unpacked 目录且 NSIS include 可被 electron-builder 接受。本机 macOS 若无法生成 Windows NSIS 安装器，记录平台限制，实际语法验证交给现有 GitHub Actions Windows 构建，不发布版本、不绕过完整性校验。

- [ ] **Step 5: 记录长期决策**

在 `MEMORY.md` 末尾追加一条 2026-09-05 决策：Windows 升级提示通过 electron-builder `nsis.include` 的 `customPageAfterChangeDir` 实现，复用既有用户/机器安装模式的 `SHELL_CONTEXT` 读取 `InstallLocation` 与 `DisplayVersion`；安装、卸载、数据和快捷方式保留仍由 electron-builder 负责。说明原因、用户影响及仅增加常数次注册表读取和静态页面的性能影响。

- [ ] **Step 6: 检查改动边界并提交决策记录**

Run: `git diff -- apps/electron/scripts/release-workflow.test.ts apps/electron/resources/installer.nsh apps/electron/electron-builder.yml MEMORY.md`

Expected: 只出现本任务的测试、NSIS include、配置接线和新增 MEMORY 条目；不包含 Server Ops、Canvas 或临时目录内容。

```bash
git add apps/electron/scripts/release-workflow.test.ts apps/electron/resources/installer.nsh apps/electron/electron-builder.yml
git commit -m "测试：验证 Windows 原位升级安装流程"
```

`MEMORY.md` 已包含其他未提交工作时不加入上述提交；仅保留本任务追加内容供用户统一整理。

## Self-Review

- 设计中的旧版本号、旧路径、目标路径、首次安装跳过、未知版本回退和 `/NCRC` 禁止项均有对应测试或实现步骤。
- 安装动作仍由 electron-builder 承担，没有复制完整 NSIS 主脚本，没有新增依赖或磁盘扫描。
- 计划未修改 macOS/Linux 配置，也不改变 `~/.proma` 与 Electron `userData`。
- 所有代码步骤都给出了完整内容，没有未定义的后续占位。
