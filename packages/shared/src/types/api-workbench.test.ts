import { describe, expect, test } from 'bun:test'
import { createApiRequestDraft, parseApiRequestDraft, parseApiCatalog, parseApiTarget } from './api-workbench'

describe('接口工作台共享合同', () => {
  test('Given 测试用例 When 解析草稿 Then 保留断言、覆盖与环境且兼容旧请求', () => {
    const base = createApiRequestDraft()
    const withCases = {
      ...base,
      cases: [{
        id: 'case_1', name: '正常登录',
        assertions: [{ id: 'ok', kind: 'status' as const, path: '', expected: '200' }],
        overrides: [{ id: 'ov', name: 'user', value: 'ada', enabled: true }],
        environmentId: 'env_test',
      }],
    }

    const parsed = parseApiRequestDraft(withCases)
    expect(parsed.cases?.[0]?.name).toBe('正常登录')
    expect(parsed.cases?.[0]?.assertions?.[0]?.expected).toBe('200')
    expect(parsed.cases?.[0]?.overrides?.[0]?.value).toBe('ada')
    expect(parsed.cases?.[0]?.environmentId).toBe('env_test')
    /** 升级前保存的请求没有 cases 字段，解析时补空数组而不是报错。 */
    expect(parseApiRequestDraft({ ...base }).cases).toEqual([])
    expect(createApiRequestDraft().cases).toEqual([])
    /** 来源由 Host 盖章：缺省是人工创建，显式声明 agent 时保留。 */
    expect(parsed.cases?.[0]?.source).toBe('user')
    expect(parseApiRequestDraft({ ...base, cases: [{ id: 'case_1', name: 'a', assertions: [], source: 'agent' as const }] }).cases?.[0]?.source).toBe('agent')
  })

  test('Given JSON 类型断言 When 解析草稿与用例 Then 类型名保留而未知断言仍被拒绝', () => {
    const base = createApiRequestDraft()
    const assertion = { id: 'type_1', kind: 'json-type' as const, path: 'data.id', expected: 'number' }

    expect(parseApiRequestDraft({ ...base, assertions: [assertion] }).assertions[0]?.kind).toBe('json-type')
    expect(parseApiRequestDraft({ ...base, cases: [{ id: 'case_1', name: 'a', assertions: [assertion] }] }).cases?.[0]?.assertions[0]?.kind).toBe('json-type')
    expect(() => parseApiRequestDraft({ ...base, assertions: [{ ...assertion, kind: 'json-schema' }] })).toThrow()
  })

  test('Given 用例身份重复、数量越界或含未知字段 When 解析 Then 明确拒绝', () => {
    const base = createApiRequestDraft()

    expect(() => parseApiRequestDraft({ ...base, cases: [{ id: 'case_1', name: 'a', assertions: [] }, { id: 'case_1', name: 'b', assertions: [] }] })).toThrow()
    expect(() => parseApiRequestDraft({ ...base, cases: Array.from({ length: 17 }, (_, index) => ({ id: `case_${index}`, name: `c${index}`, assertions: [] })) })).toThrow()
    expect(() => parseApiRequestDraft({ ...base, cases: [{ id: 'case_1', name: 'a', assertions: [], extra: 1 }] })).toThrow()
    /** 来源是固定枚举，不接受模型随意声称的第三种来源。 */
    expect(() => parseApiRequestDraft({ ...base, cases: [{ id: 'case_1', name: 'a', assertions: [], source: 'model' }] })).toThrow()
  })

  test('Given 自动 Cookie 开关 When 解析草稿 Then 缺省关闭且只接受布尔值', () => {
    const base = createApiRequestDraft()

    /** 升级前保存的请求不能因为新字段突然开始读写 cookie。 */
    expect(parseApiRequestDraft({ ...base, useCookieJar: undefined }).useCookieJar).toBe(false)
    expect(base.useCookieJar).toBe(false)
    expect(parseApiRequestDraft({ ...base, useCookieJar: true }).useCookieJar).toBe(true)
    expect(() => parseApiRequestDraft({ ...base, useCookieJar: 'yes' })).toThrow()
  })

  test('Given 提取规则 When 解析草稿 Then 校验变量名、来源与上限', () => {
    const base = createApiRequestDraft()
    const valid = { ...base, extractions: [{ id: 'ex_1', name: 'access_token', from: 'json' as const, path: 'data.token', secret: true }] }
    const badName = { ...base, extractions: [{ id: 'ex_1', name: '1token', from: 'json' as const, path: 'a', secret: false }] }
    const badFrom = { ...base, extractions: [{ id: 'ex_1', name: 'token', from: 'cookie' as const, path: 'a', secret: false }] }
    const tooMany = { ...base, extractions: Array.from({ length: 17 }, (_, index) => ({ id: `ex_${index}`, name: `v${index}`, from: 'json' as const, path: 'a', secret: false })) }

    expect(parseApiRequestDraft(valid).extractions?.[0]?.name).toBe('access_token')
    expect(() => parseApiRequestDraft(badName)).toThrow()
    expect(() => parseApiRequestDraft(badFrom)).toThrow()
    expect(() => parseApiRequestDraft(tooMany)).toThrow()
    expect(createApiRequestDraft().extractions).toEqual([])
  })

  test('Given 默认草稿 When 解析 Then 保留重复查询参数和请求头', () => {
    const draft = createApiRequestDraft()
    draft.url = 'http://127.0.0.1:8080/users'
    draft.query = [{ id: 'a', name: 'tag', value: 'one', enabled: true }, { id: 'b', name: 'tag', value: 'two', enabled: true }]
    expect(parseApiRequestDraft(draft).query).toEqual(draft.query)
  })
  test('Given 非 HTTP 地址 When 解析 Then 拒绝', () => {
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), url: 'file:///etc/passwd' })).toThrow()
  })
  test('Given 模板 URL When 解析 Then 留给准备阶段解析', () => {
    expect(parseApiRequestDraft({ ...createApiRequestDraft(), url: '{{baseUrl}}/users' }).url).toBe('{{baseUrl}}/users')
  })
  test('Given Header 换行注入 When 解析 Then 拒绝', () => {
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), headers: [{ id: 'a', name: 'X-Test', value: 'one\r\nInjected: yes', enabled: true }] })).toThrow()
  })
  test('Given 未知字段和非法方法 When 解析 Then 拒绝', () => {
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), workspaceId: 'other' })).toThrow()
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), method: 'CONNECT' })).toThrow()
  })
  test('Given 超时超预算 When 解析 Then 拒绝', () => {
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), timeoutMs: 999999999 })).toThrow()
  })
  test('Given 重复行 ID When 解析 Then 拒绝但不禁止重复名称', () => {
    const row = { id: 'a', name: 'x', value: '1', enabled: true }
    expect(() => parseApiRequestDraft({ ...createApiRequestDraft(), headers: [row, row] })).toThrow()
  })
  test('Given 越界身份 When 解析 Then 拒绝路径与未知身份字段', () => {
    expect(() => parseApiTarget({ sessionId: '../other' })).toThrow()
    expect(() => parseApiTarget({ sessionId: 'session-1', workspaceId: 'fake' })).toThrow()
  })
  test('Given 合法空目录 When 解析 Then 保持版本', () => {
    expect(parseApiCatalog({ version: 1, revision: 0, collections: [], environments: [], requests: [] }).revision).toBe(0)
  })
  test('Given 请求引用不存在的集合 When 解析目录 Then 拒绝', () => {
    expect(() => parseApiCatalog({ version: 1, revision: 0, collections: [], environments: [], requests: [{ ...createApiRequestDraft(), id: 'req-1', revision: 1, updatedAt: 1 }] })).toThrow()
  })
})

test('Given 多字节大目录 When 保存 Then 按 UTF-8 字节拒绝超预算', () => {
  const request = { ...createApiRequestDraft(), body: { kind: 'text', text: '汉'.repeat(120000), fields: [] } }
  const requests = Array.from({ length: 6 }, (_, index) => ({ ...request, id: `req-${index}`, revision: 1, updatedAt: 1 }))
  expect(() => parseApiCatalog({ version: 1, revision: 0, collections: [{ id: 'default', name: '默认', description: '', variables: [] }], environments: [], requests })).toThrow('catalog.versionOrSize')
})
