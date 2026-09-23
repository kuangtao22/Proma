import { describe, expect, test } from 'bun:test'
import { formatServerOpsDataProbeSummary, getServerOpsDataErrorMessage } from './server-ops-data-display'

describe('数据服务展示文案', () => {
  test('Given 本地 SQLite 文件权限或身份变化 When 显示错误 Then 给出可执行恢复方式', () => {
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_SQLITE_FILE_CHANGED'))).toContain('删除当前连接后重新添加')
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_SQLITE_LOCAL_FILE_PERMISSION_DENIED'))).toContain('文件权限')
  })
  test('Given 主进程在探测前拒绝本地 SQLite 文件 When 显示错误 Then 给出对应的中文处理建议', () => {
    /** 主进程文件检查早于 runtime probe，这些错误必须由渲染层直接解释。 */
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['SERVER_OPS_SQLITE_FILE_NOT_FOUND', '找不到 SQLite 文件，请确认文件路径仍然有效'],
      ['SERVER_OPS_SQLITE_FILE_NOT_REGULAR', '所选路径不是普通文件，请重新选择 SQLite 数据库文件'],
      ['SERVER_OPS_SQLITE_DATABASE_INVALID', '文件不是有效的 SQLite 数据库或数据库已损坏，请检查后重新选择'],
      ['SERVER_OPS_SQLITE_PATH_INVALID', 'SQLite 文件路径无效，请重新选择文件'],
      ['SERVER_OPS_SQLITE_FILE_UNAVAILABLE', 'SQLite 文件暂时不可用，请检查文件状态后重试'],
    ]
    for (const [code, message] of expectations) {
      expect(getServerOpsDataErrorMessage(new Error(code))).toBe(message)
      expect(getServerOpsDataErrorMessage(new Error(`Error invoking remote method 'server-ops:x': Error: ${code}`))).toBe(message)
    }
  })
  test('Given 单元格全文读取受限或身份变化 When 显示错误 Then 给出安全且可操作的中文提示', () => {
    /** 单格接口只公开稳定错误码，不展示数据库底层错误。 */
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['SERVER_OPS_DATA_CELL_TOO_LARGE', '单元格内容超过 1 MiB，无法在详情中打开'],
      ['SERVER_OPS_DATA_CELL_CHANGED', '单元格数据已变化，请刷新表后重新打开'],
      ['SERVER_OPS_DATA_CELL_REDACTED', '该敏感字段不可读取完整内容'],
      ['SERVER_OPS_DATA_CELL_TIMEOUT', '单元格完整内容读取超时，请稍后重试'],
    ]
    for (const [code, message] of expectations) expect(getServerOpsDataErrorMessage(new Error(code))).toBe(message)
  })
  test('Given 新筛选请求被旧后台合同拒绝 When 显示错误 Then 提示完整重启且不误判普通请求', () => {
    /** 现场旧主进程的 IPC 错误，不包含筛选值或数据库内容。 */
    const error = new Error("Error invoking remote method 'server-ops:read-data-schema-rows': Error: SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID")
    expect(getServerOpsDataErrorMessage(error, 'filtered-rows')).toBe('当前后台尚不支持筛选参数，请完整退出并重新启动客户端后重试')
    expect(getServerOpsDataErrorMessage(error)).not.toContain('尚不支持筛选')
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID'), 'filtered-rows')).toBe('筛选条件无效或字段不可筛选，请刷新字段后调整条件')
  })
  test('Given 主进程错误 When 映射 Then 稳定错误码收敛成可操作中文', () => {
    /** 主进程经 IPC 抛出时的真实原文形态。 */
    const invokeError = new Error("Error invoking remote method 'server-ops:upsert-data-source': Error: SERVER_OPS_SECURE_STORAGE_UNAVAILABLE")
    expect(getServerOpsDataErrorMessage(invokeError)).toBe('当前系统无法安全保存密码')
    /** 未注入 safeStorage 属于接线错误，必须与"系统不支持"给出不同提示。 */
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_SAFE_STORAGE_NOT_INJECTED')))
      .toBe('当前客户端未接入系统密钥库，请重启客户端后再试')
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_DATA_TLS_REQUIRED')))
      .toBe('直连该地址必须开启 TLS：仅回环与私有网段允许关闭 TLS，域名无法离线判定归属')
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED')))
      .toBe('请填写证书中的 DNS 主机名；数据库地址仍可使用 IP')
    expect(getServerOpsDataErrorMessage(new Error('无法识别的底层错误'))).toBe('操作失败，请稍后重试')
  })

  test('Given 数据源与运行时错误码 When 映射 Then 不再掉进无信息量的兜底文案', () => {
    /** 这些码以前都会显示"操作失败，请稍后重试"，用户看不出该做什么。 */
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['SERVER_OPS_DATA_SOURCE_HOST_INVALID', '跳板服务器无效或已被删除，请重新选择连接方式'],
      ['SERVER_OPS_DATA_SOURCE_FILE_INVALID', '本机数据源文件损坏，请检查数据根后重启客户端'],
      ['SERVER_OPS_DATA_CREDENTIAL_INVALID', '密码格式不合法：需要 1–8192 个字符且不能包含空字符'],
      ['SERVER_OPS_DATA_DISPATCH_FAILED', '数据库读取没能下发到运行时，请稍后重试'],
      ['SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID', '筛选条件无效或字段不可筛选，请刷新字段后调整条件'],
      ['SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE', '当前连接不支持安全筛选，请更新客户端后重试'],
      ['SERVER_OPS_RUNTIME_STOPPED', 'SSH 运行时已停止，请重新连接服务器后再试'],
    ]
    for (const [code, text] of expectations) {
      expect(getServerOpsDataErrorMessage(new Error(code))).toBe(text)
      /** IPC 包装后的原文同样要能命中。 */
      expect(getServerOpsDataErrorMessage(new Error(`Error invoking remote method 'server-ops:x': Error: ${code}`))).toBe(text)
    }
  })

  test('Given 主进程或 preload 版本落后 When 映射 Then 直接提示重启客户端', () => {
    /** 旧 preload 会用旧解析器拒绝渲染层新发的草稿测试输入。 */
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID')))
      .toBe('当前客户端与主进程版本不一致，请重启客户端后再试')
    /** 新通道还没注册进主进程时 Electron 抛出的原文。 */
    expect(getServerOpsDataErrorMessage(new Error(
      "Error invoking remote method 'server-ops:reveal-data-source-password': Error: No handler registered for 'server-ops:reveal-data-source-password'",
    ))).toBe('当前客户端与主进程版本不一致，请重启客户端后再试')
    /** preload 还没有新方法时浏览器抛出的真实错误。 */
    expect(getServerOpsDataErrorMessage(new TypeError('window.electronAPI.revealServerOpsDataSourcePassword is not a function')))
      .toBe('当前客户端与主进程版本不一致，请重启客户端后再试')
  })

  test('Given 连接测试结论 When 格式化 Then 成功给出版本与耗时、失败给出原因', () => {
    expect(formatServerOpsDataProbeSummary({
      engine: 'mysql', capability: 'available', serverVersion: '8.0.36', latencyMs: 12, warnings: [],
    })).toBe('已连接 · 8.0.36 · 12ms')
    expect(formatServerOpsDataProbeSummary({
      engine: 'redis', capability: 'auth-failed', warnings: ['认证失败（NOAUTH）'],
    })).toBe('认证失败 · 认证失败（NOAUTH）')
    expect(formatServerOpsDataProbeSummary({ engine: 'redis', capability: 'timeout', warnings: [] }))
      .toBe('超时')
  })

  test('Given 测试明确返回 TLS 协商状态 When 格式化 Then 展示本次事实；旧结果不推断加密', () => {
    for (const [tlsStatus, label] of [
      ['plaintext', '本次数据库未启用 TLS'], ['encrypted', '本次 TLS 加密（未校验证书）'], ['verified', '本次 TLS 加密（已校验证书）'],
    ] as const) {
      expect(formatServerOpsDataProbeSummary({ engine: 'mysql', capability: 'available', tlsStatus, warnings: [] })).toContain(label)
    }
    expect(formatServerOpsDataProbeSummary({ engine: 'mysql', capability: 'available', warnings: [] })).toBe('已连接')
  })
})
