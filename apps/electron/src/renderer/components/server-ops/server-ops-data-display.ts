import type { ServerOpsDataCapability, ServerOpsDataProbeResult } from '@proma/shared'

/** 能力状态到中文说明的稳定映射。 */
export const SERVER_OPS_DATA_CAPABILITY_LABELS: Record<ServerOpsDataCapability, string> = {
  available: '可用',
  'auth-failed': '认证失败',
  'permission-denied': '权限不足',
  unreachable: '无法连接',
  'tls-failed': 'TLS 校验失败',
  timeout: '超时',
  unsupported: '不支持',
}

/** 数据服务错误码到中文文案的稳定映射。 */
const SERVER_OPS_DATA_ERROR_MESSAGES: ReadonlyArray<{ match: string; text: string }> = [
  { match: 'SERVER_OPS_CONNECTION_NOT_ACTIVE', text: '请先连接服务器' },
  /* 数据源的稳定错误码：这几条以前会掉进"操作失败，请稍后重试"的兜底，用户看不出下一步该做什么。 */
  { match: 'SERVER_OPS_DATA_SOURCE_BUSY', text: '该数据源已有读取在进行中' },
  { match: 'SERVER_OPS_DATA_BUSY', text: '同时进行的数据库读取过多，请稍后重试' },
  { match: 'SERVER_OPS_DATA_SOURCE_NOT_FOUND', text: '数据源不存在，可能已在其它窗口删除' },
  { match: 'SERVER_OPS_DATA_SOURCE_HOST_INVALID', text: '跳板服务器无效或已被删除，请重新选择连接方式' },
  { match: 'SERVER_OPS_DATA_SOURCE_ID_INVALID', text: '数据源标识无效，请关闭后重新打开这条连接' },
  { match: 'SERVER_OPS_DATA_SOURCE_TIMESTAMP_INVALID', text: '本机时间异常，无法写入数据源' },
  { match: 'SERVER_OPS_DATA_SOURCE_FILE_INVALID', text: '本机数据源文件损坏，请检查数据根后重启客户端' },
  { match: 'SERVER_OPS_DATA_SOURCE_READ_FAILED', text: '本机数据源文件无法读取，请检查数据根' },
  { match: 'SERVER_OPS_DATA_CREDENTIAL_ID_INVALID', text: '密码凭据标识无效，请重新保存一次密码' },
  { match: 'SERVER_OPS_CREDENTIAL_REF_INVALID', text: '密码凭据引用无效，请重新保存一次密码' },
  { match: 'SERVER_OPS_DATA_CREDENTIAL_INVALID', text: '密码格式不合法：需要 1–8192 个字符且不能包含空字符' },
  { match: 'SERVER_OPS_DATA_CREDENTIAL_READ_FAILED', text: '本机密码密文文件无法读取，请检查数据根' },
  { match: 'SERVER_OPS_SECURE_STORAGE_UNAVAILABLE', text: '当前系统无法安全保存密码' },
  { match: 'SERVER_OPS_SAFE_STORAGE_NOT_INJECTED', text: '当前客户端未接入系统密钥库，请重启客户端后再试' },
  { match: 'SERVER_OPS_DATA_CREDENTIAL_CORRUPTED', text: '保存的密码无法解密，请重新输入' },
  { match: 'SERVER_OPS_DATA_TIMEOUT', text: '读取超时' },
  /* 运行时侧的错误：读取没下发成功、运行时正在重启或已经退出。 */
  { match: 'SERVER_OPS_DATA_DISPATCH_FAILED', text: '数据库读取没能下发到运行时，请稍后重试' },
  { match: 'SERVER_OPS_RUNTIME_STOPPED', text: 'SSH 运行时已停止，请重新连接服务器后再试' },
  { match: 'SERVER_OPS_RUNTIME_START_TIMEOUT', text: 'SSH 运行时启动超时，请稍后重试' },
  { match: 'SERVER_OPS_RUNTIME_FAILED', text: 'SSH 运行时异常退出，请重新连接服务器后再试' },
  {
    match: 'SERVER_OPS_DATA_TLS_REQUIRED',
    text: '直连该地址必须开启 TLS 证书校验：只有回环与私有网段（10./172.16-31./192.168./ULA）允许明文，主机名无法判定归属',
  },
]

/**
 * 判断错误是否只是"该数据源已有读取在进行中"。

 * 这是主进程的单飞门禁：说明我们自己的上一次读取还在跑、结果随后就到，
 * 因此界面必须把它当作"稍等"而不是"失败"——否则一次误触刷新就会把已有结果擦掉。
 *
 * @param error 主进程错误
 * @returns 是否为单飞冲突
 */
export function isServerOpsDataSourceBusyError(error: unknown): boolean {
  /** 原始错误文本。 */
  const text = error instanceof Error ? error.message : String(error)
  return text.includes('SERVER_OPS_DATA_SOURCE_BUSY') || text.includes('该数据源已有读取在进行中')
}

/**
 * 旧客户端（preload 或主进程 bundle 落后于渲染层）留下的可识别信号。
 *
 * 渲染层由 Vite 热更、主进程与 preload 是打包产物（只在进程启动时加载），
 * 三者版本不一致时最常见的表现就是"按钮点了报一句看不出原因的话"：
 * 旧 preload 不认识新增的草稿测试输入、主进程还没注册新通道、preload 还没有新方法。
 */
const SERVER_OPS_DATA_STALE_CLIENT_HINTS = [
  'SERVER_OPS_DATA_SOURCE_PROBE_INPUT_INVALID',
  'No handler registered',
  'is not a function',
]

/**
 * 把主进程错误映射为可读中文文案。
 *
 * 主进程通过 IPC 抛出的原文形如 `Error invoking remote method '…': Error: SERVER_OPS_XXX`，
 * 直接展示给用户既不可读也无法判断下一步，因此这里统一收敛成中文说明。
 *
 * @param error 主进程抛出的错误
 * @returns 面向用户的中文说明
 */
export function getServerOpsDataErrorMessage(error: unknown): string {
  /** 原始错误消息文本。 */
  const text = error instanceof Error ? error.message : String(error)
  for (const entry of SERVER_OPS_DATA_ERROR_MESSAGES) {
    if (text.includes(entry.match)) return entry.text
  }
  /**
   * 表浏览失败时主进程会把 runtime 给出的中文原因拼在错误码后面
   * （`SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: 认证失败（…）`）：这类原因本身就是给用户看的，
   * 直接透出比套一层兜底文案更有用。
   */
  const schemaFailurePrefix = 'SERVER_OPS_DATA_SCHEMA_UNAVAILABLE: '
  const schemaFailure = text.split(schemaFailurePrefix)[1]
  if (schemaFailure !== undefined) return schemaFailure.trim() === '' ? '数据读取失败，请检查连接与账号权限' : schemaFailure.trim()
  /** 版本不一致必须先认出来，否则用户只会看到一句无信息量的兜底。 */
  if (SERVER_OPS_DATA_STALE_CLIENT_HINTS.some((hint) => text.includes(hint))) {
    return '当前客户端与主进程版本不一致，请重启客户端后再试'
  }
  return '操作失败，请稍后重试'
}

/**
 * 把一次连接测试结论格式化为一行中文摘要。
 *
 * 数据源列表、单连接详情与新建弹窗共用同一份措辞，
 * 避免"测试通过"在三个地方出现三种说法。
 *
 * @param result 连接测试结论
 * @returns 例如 `已连接 · 8.0.36 · 12ms`
 */
export function formatServerOpsDataProbeSummary(result: ServerOpsDataProbeResult): string {
  if (result.capability === 'available') {
    return ['已连接', result.serverVersion, result.latencyMs === undefined ? undefined : `${result.latencyMs}ms`]
      .filter((part): part is string => part !== undefined && part !== '').join(' · ')
  }
  return [SERVER_OPS_DATA_CAPABILITY_LABELS[result.capability], result.warnings[0]]
    .filter((part): part is string => part !== undefined && part !== '').join(' · ')
}
