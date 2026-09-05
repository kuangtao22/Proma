# Windows 升级安装提示设计

## 目标

当 Windows 用户运行 Proma Bone 安装包且系统中已经存在同一应用身份的旧版本时，安装器应明确展示检测到的旧版本号和安装目录，并默认沿用该目录完成升级。首次安装仍保持现有安装流程。

这里的“升级”不是直接覆盖正在使用的程序文件。安装器继续调用 electron-builder 的旧版卸载流程，再把新版本安装回原目录；`~/.proma` 业务数据、快捷方式和用户选择按现有 `--updated` 语义保留。

## 现状与问题

- 当前 Windows 安装器采用 electron-builder assisted NSIS：`oneClick: false`、`allowToChangeInstallationDirectory: true`。
- electron-builder 已从 `HKCU` 和 `HKLM` 的稳定 `APP_GUID` 注册表键读取旧安装目录，并在升级时调用旧卸载器。
- 现有界面只把旧目录作为默认安装目录，没有明确告诉用户检测到了哪个旧版本、将升级哪个位置。
- NSIS 自身的完整性检查发生在所有安装页面之前。本设计不绕过 CRC，也不处理下载损坏；损坏的安装包必须重新下载。

## 方案比较

### 方案 A：只依赖现有目录页

不增加代码，继续让 electron-builder 静默复用旧目录。维护成本最低，但用户无法区分“首次安装到默认目录”和“正在升级已有版本”，不满足目标。

### 方案 B：使用 electron-builder 的 NSIS include 扩展点

新增最小 `installer.nsh`，复用模板已经读取的旧安装事实，在安装目录页之后插入只读升级摘要。首次安装时页面自动跳过。实现局部、可测试，不复制 electron-builder 主安装脚本。

这是采用方案。

### 方案 C：维护完整自定义 NSIS script

可以完全控制安装向导，但需要长期跟随 electron-builder 的安装、卸载、差分更新和权限逻辑，升级风险与上游合并成本过高。

## 交互设计

检测到旧安装时显示独立摘要页：

```text
升级现有 Proma

检测到已安装版本：Proma <旧版本>
安装位置：<旧安装目录>

继续后将关闭正在运行的 Proma，保留本地业务数据，
并在原位置安装 Proma <新版本>。
```

- 主按钮沿用向导的“安装/下一步”，默认进入原位升级。
- 用户在之前的目录页选择其他位置后，摘要仍显示注册表中的旧位置，并说明旧程序将先卸载、新版本安装到当前选择的位置。
- 如果注册表有安装路径但缺少 `DisplayVersion`，版本显示为“未知版本”，仍允许升级。
- 如果没有旧安装路径，摘要页使用 `Abort` 跳过，不增加首次安装步骤。
- 不提供“直接覆盖文件”选项，不提供 `/NCRC` 绕过。

## 技术设计

### 应用身份

继续使用 `appId: com.bone.proma.app` 派生稳定 `APP_GUID`。不新增第二套注册表键，不扫描磁盘猜测安装位置。

### NSIS 扩展

在 `apps/electron/electron-builder.yml` 的 `nsis.include` 指向 `resources/installer.nsh`。

自定义 include 通过 `customPageAfterChangeDir` 宏接入 electron-builder assisted installer，在页面创建时：

1. 复用模板已根据 per-user/per-machine 安装状态设置的 `SHELL_CONTEXT`；
2. 从该上下文的 `${INSTALL_REGISTRY_KEY}` 读取 `InstallLocation`；
3. 从同一上下文的 `${UNINSTALL_REGISTRY_KEY}` 读取 `DisplayVersion`；
4. 没有旧路径时跳过页面；
5. 有旧路径时用 `nsDialogs` 渲染只读版本、旧路径和目标路径。

安装动作、旧进程关闭、旧卸载器执行、快捷方式保留和数据保留全部继续由 electron-builder 模板负责。

## 错误处理

- 旧版本号缺失：显示“未知版本”，不阻止升级。
- 旧路径缺失：按首次安装处理，不显示升级摘要。
- 注册表同时存在 per-user 和 per-machine 安装：跟随 electron-builder 已选择的安装模式，避免自行决定权限边界。
- 安装器完整性校验失败：仍在进入界面前阻断，不允许绕过。

## 关联影响

- Windows 手动安装和后续自动更新共用同一 NSIS 包，都会沿用稳定应用身份。
- 不修改 macOS/Linux 打包配置。
- 不修改 `~/.proma`、Electron `userData` 或会话数据。
- 不新增运行时依赖；改动只存在于 Windows 安装阶段。

## 性能与资源

安装器仅增加常数次注册表读取和一个静态 `nsDialogs` 页面，不增加应用启动开销、后台进程、网络请求或安装包中的运行时依赖。

## 验证

- 发布合同测试锁定 `nsis.include`、升级页面宏、注册表路径/版本读取和首次安装跳过条件。
- 正常路径：存在旧路径和版本时显示两项事实并继续安装。
- 边界路径：存在旧路径但版本缺失时显示“未知版本”。
- 首次安装：没有旧路径时跳过摘要页。
- Windows GitHub Actions 实际编译安装包，验证 NSIS 语法与 electron-builder 集成。
- 发布后在 Windows 沙箱或虚拟机执行旧版安装后升级冒烟，确认原目录、快捷方式和 `~/.proma` 数据保留。

## 非目标

- 不修复或绕过损坏下载导致的 NSIS integrity error。
- 不扫描任意磁盘目录寻找便携版或被手动移动的程序。
- 不迁移官方 `com.proma.app` 到 Bone `com.bone.proma.app`；跨应用身份迁移需要独立设计。
- 不在本次加入 Windows Authenticode 签名。
