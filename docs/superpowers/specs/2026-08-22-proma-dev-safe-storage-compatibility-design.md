# Proma Dev Safe Storage 兼容设计

## 结论

直接启动的 Electron 开发客户端恢复显示为 `Proma Dev`，但启动期继续使用历史内部名称 `@proma/electron` 初始化 macOS Safe Storage。本设计取代此前将开发运行时名称改为 `PromaDev` 的决定，也修正“旧密文由 `Proma Dev Safe Storage` 加密”的错误假设。

正式打包版仍使用 `Proma / com.bone.proma.app`；开发版仍使用 `com.bone.proma.dev` 和独立的 Electron `userData`，并继续与正式版共享 `~/.proma` 业务配置。

## 数据流与边界

- Electron 在 `ready` 前使用稳定的 `@proma/electron` 内部名称，使 `safeStorage` 解析到已有的 `@proma/electron Safe Storage`；`ready` 后再设置开发客户端显示名 `Proma Dev`，多工作树实例显示为 `Proma Dev - <instance>`。
- 现有渠道、飞书和微信配置的创建时间均早于 `Proma Dev Safe Storage`，无窗口 Electron 探针也已验证仅 `@proma/electron` 能解密现有渠道密文。
- 不修改渠道配置格式、API Key 密文、签名、应用 ID、发布配置或 `userData` 目录。
- 不删除新建的 `PromaDev Safe Storage` 钥匙串项，避免执行破坏性外部操作；它不再被默认开发实例使用。

## 影响

用户在 Dock、任务栏和系统菜单中看到的开发客户端名称恢复为带空格的 `Proma Dev`。渠道、飞书、钉钉、微信和语音输入等复用 Electron `safeStorage` 的凭据均重新使用真正的历史密钥。该修改只调整启动期身份顺序，不增加可感知的运行时计算、内存、网络或磁盘开销。

## 错误处理

若原钥匙串项已被用户删除或系统钥匙串不可用，现有解密错误仍会保留并提示重新填写凭据；本次不增加自动迁移或静默降级为明文的逻辑。

## 验收

- 打包环境解析为 `Proma / com.bone.proma.app`。
- 默认开发环境解析为 `Proma Dev / com.bone.proma.dev`，Safe Storage 身份固定为 `@proma/electron`。
- 多工作树开发环境解析为 `Proma Dev - <instance>`，Safe Storage 身份仍为 `@proma/electron`，实例清理和 `userData` 隔离保持不变。
- 身份回归测试先失败后通过，相关类型检查通过。
- 重启开发客户端后，界面显示 `Proma Dev`，已有渠道、飞书和微信密文均可解密。
