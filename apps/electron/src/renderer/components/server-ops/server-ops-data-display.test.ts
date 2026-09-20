import { describe, expect, test } from 'bun:test'
import { formatServerOpsDataProbeSummary, getServerOpsDataErrorMessage } from './server-ops-data-display'

describe('数据服务展示文案', () => {
  test('Given 主进程错误 When 映射 Then 稳定错误码收敛成可操作中文', () => {
    /** 主进程经 IPC 抛出时的真实原文形态。 */
    const invokeError = new Error("Error invoking remote method 'server-ops:upsert-data-source': Error: SERVER_OPS_SECURE_STORAGE_UNAVAILABLE")
    expect(getServerOpsDataErrorMessage(invokeError)).toBe('当前系统无法安全保存密码')
    /** 未注入 safeStorage 属于接线错误，必须与"系统不支持"给出不同提示。 */
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_SAFE_STORAGE_NOT_INJECTED')))
      .toBe('当前客户端未接入系统密钥库，请重启客户端后再试')
    expect(getServerOpsDataErrorMessage(new Error('SERVER_OPS_DATA_TLS_REQUIRED')))
      .toBe('直连该地址必须开启 TLS 证书校验：只有回环与私有网段（10./172.16-31./192.168./ULA）允许明文，主机名无法判定归属')
    expect(getServerOpsDataErrorMessage(new Error('无法识别的底层错误'))).toBe('操作失败，请稍后重试')
  })

  test('Given 数据源与运行时错误码 When 映射 Then 不再掉进无信息量的兜底文案', () => {
    /** 这些码以前都会显示"操作失败，请稍后重试"，用户看不出该做什么。 */
    const expectations: ReadonlyArray<readonly [string, string]> = [
      ['SERVER_OPS_DATA_SOURCE_HOST_INVALID', '跳板服务器无效或已被删除，请重新选择连接方式'],
      ['SERVER_OPS_DATA_SOURCE_FILE_INVALID', '本机数据源文件损坏，请检查数据根后重启客户端'],
      ['SERVER_OPS_DATA_CREDENTIAL_INVALID', '密码格式不合法：需要 1–8192 个字符且不能包含空字符'],
      ['SERVER_OPS_DATA_DISPATCH_FAILED', '数据库读取没能下发到运行时，请稍后重试'],
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
})
