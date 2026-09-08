import type { ComfyWorkflowIssue } from './comfyui-workflow'

/** 工具错误最多返回的工作流问题数，避免大图诊断挤占 Agent 上下文。 */
const MAX_EXPOSED_ISSUES = 4
/** 可公开的节点与输入定位符，只接受既有工作流合同允许的字符。 */
const SAFE_LOCATION_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/

/** 可安全展示的工作流问题最小形状。 */
interface SafeWorkflowIssue {
  code: string
  nodeId?: string
  input?: string
}

/** 将结构校验码映射为稳定中文说明，绝不转发底层错误正文。 */
function validationReason(code: string): string {
  const reasons: Readonly<Record<string, string>> = {
    NODE_CLASS_UNKNOWN: '服务器未安装该节点',
    NODE_CLASS_UNSAFE: '节点没有安全执行合同',
    NODE_INTERFACE_UNSUPPORTED: '服务器未提供可验证的节点接口',
    INPUT_REQUIRED: '缺少必填输入',
    INPUT_UNKNOWN: '输入不在节点接口中',
    INPUT_HIDDEN: '输入不可由工作流提交',
    INPUT_ENUM_INVALID: '输入不在服务器允许选项中',
    INPUT_TYPE_INVALID: '输入类型与服务器要求不匹配',
    INPUT_RANGE_INVALID: '数值超出服务器允许范围',
    LINK_NODE_UNKNOWN: '连接来源节点不存在',
    LINK_TYPE_INVALID: '连接两端类型不兼容',
    LINK_LIST_UNSUPPORTED: '当前不支持列表连接',
    OUTPUT_INDEX_INVALID: '连接引用了不存在的输出',
    WORKFLOW_CYCLE: '工作流包含循环依赖',
    OUTPUT_REQUIRED: '缺少可收集的输出节点',
    OUTPUT_SELECTOR_INVALID: '输出选择器无效',
    OUTPUT_MEDIA_UNSUPPORTED: '输出媒体类型未适配',
    OUTPUT_DECLARATION_REQUIRED: '输出节点缺少可收集声明',
    OUTPUT_PREFIX_INVALID: '输出目录前缀不安全',
    BINDING_TARGET_INVALID: '媒体绑定目标无效',
    RESOURCE_BINDING_REQUIRED: '资源输入必须使用受管素材绑定',
    RESOURCE_CONSTANT_FORBIDDEN: '资源输入不能直接写入远端路径',
    RESOURCE_ENUM_REQUIRED: '资源输入缺少服务器文件枚举合同',
    RESOURCE_CONTRACT_REQUIRED: '资源输入缺少安全上传合同',
  }
  return reasons[code] ?? '工作流结构不满足安全执行要求'
}

/** 将远端 UI 转换问题映射为稳定中文说明，避免输出原始工作流内容。 */
function importReason(code: string): string {
  const reasons: Readonly<Record<string, string>> = {
    UI_SUBGRAPH_UNSUPPORTED: '工作流包含当前无法安全展开的子图',
    UI_SUBGRAPH_INPUT_MISMATCH: '子图实例输入与定义不一致，需在 ComfyUI 修复并重新保存',
    UI_SUBGRAPH_OUTPUT_MISMATCH: '子图实例输出与定义不一致',
    UI_SUBGRAPH_INPUT_UNRESOLVED: '子图输入缺少明确连线或控件值',
    UI_SUBGRAPH_LINK_INVALID: '子图连线与接口槽位声明不一致',
    UI_SUBGRAPH_WIDGET_MAPPING_UNSUPPORTED: '子图控件值无法与输入逐一对应',
    UI_SUBGRAPH_PROXY_UNSUPPORTED: '遗留代理控件缺少可证明的映射',
    UI_SUBGRAPH_DEFINITION_INVALID: '子图定义不完整或包含重复标识',
    UI_SUBGRAPH_GRAPH_INVALID: '子图节点或连线格式无效',
    UI_SUBGRAPH_HOST_INVALID: '子图实例标识无效',
    UI_SUBGRAPH_NODE_MODE_UNSUPPORTED: '子图包含尚未适配的禁用或旁路模式',
    UI_SUBGRAPH_CYCLE: '子图定义存在递归引用',
    UI_SUBGRAPH_DEPTH_EXCEEDED: '子图嵌套超过分析上限',
    UI_SUBGRAPH_LIMIT_EXCEEDED: '子图展开超过节点或连线数量上限',
    UI_WIDGET_INVALID: '界面控件值无效',
    UI_WIDGET_MISSING: '界面控件值缺失',
    UI_WIDGET_UNMAPPED: '存在无法映射到 API 的界面控件',
    UI_LINK_INVALID: '界面连接不完整或不一致',
    UI_INPUT_INVALID: '界面输入槽无效',
    UI_INPUT_UNKNOWN: '界面输入不在服务器接口中',
    NODE_CLASS_UNKNOWN: '目标服务器未安装该节点',
    NODE_INTERFACE_UNSUPPORTED: '目标服务器未提供可验证的节点接口',
    NODE_CONTRACT_UNSUPPORTED: '节点缺少本地执行合同',
    REMOTE_WORKFLOW_FORMAT_UNSUPPORTED: '远端工作流格式不受支持',
    REMOTE_WORKFLOW_INVALID: '远端工作流结构无效',
    REMOTE_WORKFLOW_LIMIT_EXCEEDED: '远端工作流超过安全分析上限',
  }
  return reasons[code] ?? '工作流无法安全转换为 API prompt'
}

/** 将可信问题格式化为有界 code、定位和中文原因。 */
function describeIssue(issue: SafeWorkflowIssue, reason: (code: string) => string): string {
  /** 结构校验器产生的稳定错误码；异常形状使用保守码。 */
  const code = /^[A-Z0-9_]{1,96}$/.test(issue.code) ? issue.code : 'WORKFLOW_ISSUE_UNKNOWN'
  /** 仅输出通过标识符合同的定位，不回显任意远端字段。 */
  const location = [issue.nodeId, issue.input]
    .filter((value): value is string => typeof value === 'string' && SAFE_LOCATION_PATTERN.test(value))
    .join('.')
  return `${code}${location ? `@${location}` : ''}:${reason(code)}`
}

/** 静态执行校验失败，保留可信问题供受控工具边界展示。 */
export class MediaWorkflowValidationError extends Error {
  /** 原始校验问题仅在主进程可信代码内保留，不直接输出给 Agent。 */
  readonly issues: readonly ComfyWorkflowIssue[]

  constructor(issues: readonly ComfyWorkflowIssue[]) {
    /** 复制并限长，防止后续调用方改写诊断或扩大错误回执。 */
    const boundedIssues = issues.slice(0, MAX_EXPOSED_ISSUES).map((issue) => ({ ...issue }))
    super(`MEDIA_WORKFLOW_INVALID:${boundedIssues.map((issue) => describeIssue(issue, validationReason)).join('|') || 'WORKFLOW_ISSUE_UNKNOWN:工作流校验失败'}`)
    this.name = 'MediaWorkflowValidationError'
    this.issues = Object.freeze(boundedIssues)
  }
}

/** 远端导入分析失败，保留首批可信结构问题供工具层说明和分页跳转。 */
export class MediaRemoteWorkflowImportError extends Error {
  /** 分析器问题只保留有界副本，完整列表仍须通过 issues 分页读取。 */
  readonly issues: readonly SafeWorkflowIssue[]

  constructor(issues: readonly SafeWorkflowIssue[]) {
    /** 复制并限长，避免远端工作流把任意大量字段放入 Error。 */
    const boundedIssues = issues.slice(0, MAX_EXPOSED_ISSUES).map((issue) => ({
      code: issue.code,
      ...(typeof issue.nodeId === 'string' ? { nodeId: issue.nodeId } : {}),
      ...(typeof issue.input === 'string' ? { input: issue.input } : {}),
    }))
    super(`MEDIA_REMOTE_WORKFLOW_NOT_IMPORTABLE:${boundedIssues.map((issue) => describeIssue(issue, importReason)).join('|') || 'WORKFLOW_ISSUE_UNKNOWN:工作流无法安全转换为 API prompt'}:请调用 media_read_remote_workflow(section=issues) 分页读取完整原因`)
    this.name = 'MediaRemoteWorkflowImportError'
    this.issues = Object.freeze(boundedIssues)
  }
}
