import type { ServerOpsDataCapability, ServerOpsDataProbeResult, ServerOpsDataTlsMode } from '@proma/shared'

/** 能力状态到中文说明的稳定映射。 */
export const SERVER_OPS_DATA_CAPABILITY_LABELS: Record<ServerOpsDataCapability, string> = {
  available: '可用',
  'auth-failed': '认证失败',
  'permission-denied': '权限不足',
  unreachable: '无法连接',
  'tls-failed': 'TLS 连接失败',
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
  { match: 'SERVER_OPS_DATA_SOURCE_CHANGED', text: '连接配置已更新，请重新进入连接后再试' },
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
  { match: 'SERVER_OPS_SQLITE_FILE_NOT_FOUND', text: '找不到 SQLite 文件，请确认文件路径仍然有效' },
  { match: 'SERVER_OPS_SQLITE_FILE_NOT_REGULAR', text: '所选路径不是普通文件，请重新选择 SQLite 数据库文件' },
  { match: 'SERVER_OPS_SQLITE_DATABASE_INVALID', text: '文件不是有效的 SQLite 数据库或数据库已损坏，请检查后重新选择' },
  { match: 'SERVER_OPS_SQLITE_PATH_INVALID', text: 'SQLite 文件路径无效，请重新选择文件' },
  { match: 'SERVER_OPS_SQLITE_FILE_UNAVAILABLE', text: 'SQLite 文件暂时不可用，请检查文件状态后重试' },
  { match: 'SERVER_OPS_SQLITE_FILE_CHANGED', text: 'SQLite 文件已被替换；请删除当前连接后重新添加' },
  { match: 'SERVER_OPS_SQLITE_LOCAL_FILE_PERMISSION_DENIED', text: '无法读取本地 SQLite 文件，请检查文件权限' },
  { match: 'SERVER_OPS_DATA_CELL_TOO_LARGE', text: '单元格内容超过 1 MiB，无法在详情中打开' },
  { match: 'SERVER_OPS_DATA_CELL_CHANGED', text: '单元格数据已变化，请刷新表后重新打开' },
  { match: 'SERVER_OPS_DATA_CELL_REDACTED', text: '该敏感字段不可读取完整内容' },
  { match: 'SERVER_OPS_DATA_CELL_TIMEOUT', text: '单元格完整内容读取超时，请稍后重试' },
  { match: 'SERVER_OPS_DATA_SCHEMA_FILTERS_INVALID', text: '筛选条件无效或字段不可筛选，请刷新字段后调整条件' },
  { match: 'SERVER_OPS_DATA_SCHEMA_FILTERS_UNAVAILABLE', text: '当前连接不支持安全筛选，请更新客户端后重试' },
  /* 运行时侧的错误：读取没下发成功、运行时正在重启或已经退出。 */
  { match: 'SERVER_OPS_DATA_DISPATCH_FAILED', text: '数据库读取没能下发到运行时，请稍后重试' },
  { match: 'SERVER_OPS_RUNTIME_STOPPED', text: 'SSH 运行时已停止，请重新连接服务器后再试' },
  { match: 'SERVER_OPS_RUNTIME_START_TIMEOUT', text: 'SSH 运行时启动超时，请稍后重试' },
  { match: 'SERVER_OPS_RUNTIME_FAILED', text: 'SSH 运行时异常退出，请重新连接服务器后再试' },
  {
    match: 'SERVER_OPS_DATA_TLS_REQUIRED',
    text: '直连该地址必须开启 TLS：仅回环与私有网段允许关闭 TLS，域名无法离线判定归属',
  },
  { match: 'SERVER_OPS_DATA_TLS_SERVER_NAME_REQUIRED', text: '请填写证书中的 DNS 主机名；数据库地址仍可使用 IP' },
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
  'SERVER_OPS_DATA_DEFAULT_DATABASE_UNAVAILABLE',
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
 * @param context 可选的已校验请求场景，用于区分旧后台合同与普通输入错误
 * @returns 面向用户的中文说明
 */
export function getServerOpsDataErrorMessage(error: unknown, context?: 'filtered-rows'): string {
  /** 原始错误消息文本。 */
  const text = error instanceof Error ? error.message : String(error)
  /** 新筛选请求在旧行合同入口被拒绝时，查询尚未送达数据库；重复重试无法恢复。 */
  if (context === 'filtered-rows' && text.includes('SERVER_OPS_DATA_SCHEMA_ROWS_INPUT_INVALID')) {
    return '当前后台尚不支持筛选参数，请完整退出并重新启动客户端后重试'
  }
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
    return ['已连接', formatServerOpsDataTlsStatus(result.tlsStatus), result.serverVersion, result.latencyMs === undefined ? undefined : `${result.latencyMs}ms`]
      .filter((part): part is string => part !== undefined && part !== '').join(' · ')
  }
  return [SERVER_OPS_DATA_CAPABILITY_LABELS[result.capability], result.warnings[0]]
    .filter((part): part is string => part !== undefined && part !== '').join(' · ')
}

/** 根据本次握手的实测状态生成文案；缺失状态的旧结果保持未知。 */
export function formatServerOpsDataTlsStatus(status: ServerOpsDataProbeResult['tlsStatus']): string | undefined {
  if (status === 'plaintext') return '本次数据库未启用 TLS'
  if (status === 'encrypted') return '本次 TLS 加密（未校验证书）'
  if (status === 'verified') return '本次 TLS 加密（已校验证书）'
  return undefined
}

/** 将保存的连接策略与实际握手结果区分，避免列表上的设置标记冒充实测状态。 */
export function formatServerOpsDataTlsPolicy(mode: ServerOpsDataTlsMode): string | undefined {
  if (mode === 'preferred') return '优先 TLS'
  if (mode === 'required') return '必须 TLS'
  if (mode === 'verify') return '校验证书'
  return undefined
}
