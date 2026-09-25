import { describe, expect, test } from 'bun:test'
import { Value } from 'typebox/value'
import { API_AGENT_TOOL_NAMES, buildApiAgentTools } from './api-agent-tools'

/** 只取 defineTool 的最小 SDK 替身；schema 校验与真实 SDK 使用同一份 TypeBox 定义。 */
const sdk = { defineTool: <T>(tool: T): T => tool }
/** 构建期不需要真实 facade：这里只核对参数合同。 */
const tools = buildApiAgentTools(sdk as never, {} as never)
/** 按名字取出工具定义。 */
function tool(name: string) {
  const found = tools.find((item) => item.name === name)
  if (!found) throw new Error(`缺少工具 ${name}`)
  return found
}
/** 用真实 TypeBox 校验器判断参数是否被接受，等价于 SDK 调用前的参数检查。 */
function accepts(name: string, args: unknown): boolean {
  return Value.Check(tool(name).parameters, args)
}

describe('接口工作台 Agent 工具合同', () => {
  test('Given 普通交互运行 When 构建工具 Then 只暴露六个窄工具', () => {
    expect(tools.map((item) => item.name)).toEqual([...API_AGENT_TOOL_NAMES])
  })

  test('Given Agent 声明具名用例 When 校验参数 Then 接受 cases 与覆盖但拒绝伪造来源', () => {
    const validCase = { id: 'case_login_401', name: '未授权返回 401', assertions: [{ id: 'a1', kind: 'status', path: '', expected: '401' }] }

    expect(accepts('api_prepare_request', { request: { url: 'https://example.test', cases: [validCase] } })).toBe(true)
    expect(accepts('api_prepare_request', { request: { cases: [{ ...validCase, overrides: [{ id: 'o1', name: 'user', value: 'ada', enabled: true }], environmentId: 'env_test' }] } })).toBe(true)
    /** 来源必须由 Host 盖章，模型不能自己声明。 */
    expect(accepts('api_prepare_request', { request: { cases: [{ ...validCase, source: 'user' }] } })).toBe(false)
    /** 用例数量与断言条数都有上限。 */
    expect(accepts('api_prepare_request', { request: { cases: Array.from({ length: 17 }, (_value, index) => ({ ...validCase, id: `case_${index}` })) } })).toBe(false)
    expect(accepts('api_prepare_request', { request: { cases: [{ ...validCase, assertions: Array.from({ length: 65 }, (_value, index) => ({ id: `a${index}`, kind: 'status', path: '', expected: '200' })) }] } })).toBe(false)
    /** 用例身份必须能作为稳定资源 id，未知字段一律拒绝。 */
    expect(accepts('api_prepare_request', { request: { cases: [{ ...validCase, id: 'case 1' }] } })).toBe(false)
    expect(accepts('api_prepare_request', { request: { cases: [{ ...validCase, extra: 1 }] } })).toBe(false)
  })

  test('Given 已有用例 When 按用例执行或保存 Then 仍只暴露身份参数', () => {
    expect(accepts('api_prepare_request', { requestId: 'request_1', caseId: 'case_human' })).toBe(true)
    expect(accepts('api_save_request', { preparedId: 'prepared_1', expectedRevision: 3 })).toBe(true)
    expect(accepts('api_save_request', { preparedId: 'prepared_1', expectedRevision: 3, definition: {} })).toBe(false)
  })

  test('Given 自动 Cookie When 校验参数 Then 只接受布尔开关且取值通道不在工具里', () => {
    expect(accepts('api_prepare_request', { request: { useCookieJar: true } })).toBe(true)
    expect(accepts('api_prepare_request', { request: { useCookieJar: 'yes' } })).toBe(false)
    /** 没有任何读取 cookie 取值的工具参数。 */
    expect(accepts('api_inspect_run', { runId: 'run_1', section: 'cookies' })).toBe(false)
    expect(accepts('api_prepare_request', { cookieJar: [] })).toBe(false)
  })

  test('Given Agent 声明本机文件 When 校验参数 Then 只接受路径声明而不是引用或字节', () => {
    const multipart = (files: unknown): unknown => ({ request: { url: 'https://example.test', method: 'POST', body: { kind: 'multipart', text: '', fields: [], files } } })
    const declared = { id: 'part_1', name: 'file', path: '/tmp/report.pdf' }

    expect(accepts('api_prepare_request', multipart([{ ...declared, contentType: 'application/pdf' }]))).toBe(true)
    /** 路径必填：只给字段名会让 Host 无法判断要读哪个文件。 */
    expect(accepts('api_prepare_request', multipart([{ id: 'part_1', name: 'file' }]))).toBe(false)
    /** 模型不能自带引用、大小或文件名，这些由 Host 在 realpath + stat 之后签发。 */
    expect(accepts('api_prepare_request', multipart([{ ...declared, ref: 'file_1' }]))).toBe(false)
    expect(accepts('api_prepare_request', multipart([{ ...declared, fileName: 'report.pdf', sizeBytes: 3 }]))).toBe(false)
    /** 单次请求的文件条数与共享上限一致（16）。 */
    expect(accepts('api_prepare_request', multipart(Array.from({ length: 17 }, (_value, index) => ({ ...declared, id: `part_${index}` }))))).toBe(false)
    /**
     * schema 不表达「文件必须配 multipart」这种条件约束（会变成难读的联合类型），
     * 该搭配由 Host 在 prepare 阶段以 API_WORKBENCH_INVALID: body.files.multipartOnly 拒绝。
     */
    expect(accepts('api_prepare_request', { request: { url: 'https://example.test', body: { kind: 'urlencoded', text: '', fields: [], files: [declared] } } })).toBe(true)
  })
})
