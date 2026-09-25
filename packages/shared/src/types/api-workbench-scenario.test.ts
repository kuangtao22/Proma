import { describe, expect, test } from 'bun:test'
import { API_LIMITS, createApiRequestDraft, parseApiCatalog, parseApiScenario } from './api-workbench'

/** 构造一条持久请求定义，场景步骤只能引用这种身份。 */
function request(id: string, name: string) {
  return { ...createApiRequestDraft('default'), id, revision: 1, updatedAt: 1, name }
}

/** 构造一个目录；scenarios 是否出现由调用方决定，用于验证升级兼容。 */
function catalog(options: { requests?: ReturnType<typeof request>[]; scenarios?: unknown[]; withScenariosKey?: boolean } = {}): unknown {
  return {
    version: 1, revision: 3,
    collections: [{ id: 'default', name: '后台', description: '', variables: [] }],
    environments: [{ id: 'env_test', name: '测试环境', kind: 'test', variables: [] }],
    requests: options.requests ?? [request('request_login', '登录'), request('request_profile', '用户详情')],
    ...(options.withScenariosKey === false ? {} : { scenarios: options.scenarios ?? [] }),
  }
}

/** 一个最小的两步骤场景声明。 */
function scenario(steps: unknown[] = [
  { id: 'step_login', name: '登录', requestId: 'request_login' },
  { id: 'step_profile', name: '用户详情', requestId: 'request_profile' },
]) {
  return {
    id: 'scenario_login_flow', name: '登录后看详情', description: '冒烟流程',
    collectionId: 'default', folder: '用户模块', steps, environmentId: 'env_test',
    onFailure: 'stop', revision: 1, updatedAt: 1,
  }
}

describe('场景（流程）合同', () => {
  test('Given 升级前保存的目录 When 解析 Then 补空数组而不是报错', () => {
    const parsed = parseApiCatalog(catalog({ withScenariosKey: false }))

    expect(parsed.scenarios).toEqual([])
    expect(parsed.version).toBe(1)
    expect(parsed.revision).toBe(3)
  })

  test('Given 合法场景 When 解析 Then 保留步骤顺序与可选字段', () => {
    const raw = scenario([
      { id: 'step_login', name: '登录', requestId: 'request_login' },
      { id: 'step_profile', name: '用户详情', requestId: 'request_profile', caseId: 'case_ok', environmentId: 'env_test', onFailure: 'continue', overrides: [{ id: 'field_u', name: 'userId', value: '1', enabled: true }] },
    ])

    const parsed = parseApiCatalog(catalog({ scenarios: [raw] })).scenarios

    expect(parsed?.map((item) => item.id)).toEqual(['scenario_login_flow'])
    /** 数组顺序就是执行顺序，必须原样保留。 */
    expect(parsed?.[0]?.steps.map((step) => step.id)).toEqual(['step_login', 'step_profile'])
    expect(parsed?.[0]?.steps[0]?.onFailure).toBeUndefined()
    expect(parsed?.[0]?.steps[1]?.onFailure).toBe('continue')
    expect(parsed?.[0]?.steps[1]?.caseId).toBe('case_ok')
    expect(parsed?.[0]?.steps[1]?.overrides?.[0]?.name).toBe('userId')
    expect(parsed?.[0]?.environmentId).toBe('env_test')
    expect(parsed?.[0]?.onFailure).toBe('stop')
  })

  test('Given 场景缺省失败策略 When 解析 Then 一律按 stop 而不是静默继续', () => {
    const raw = { ...scenario(), onFailure: undefined }

    expect(parseApiScenario(raw).onFailure).toBe('stop')
  })

  test('Given 步骤超过上限 When 解析 Then 拒绝', () => {
    const steps = Array.from({ length: API_LIMITS.maxScenarioSteps + 1 }, (_value, index) => ({ id: `step_${index}`, name: `步骤 ${index}`, requestId: 'request_login' }))

    expect(() => parseApiScenario(scenario(steps))).toThrow('API_WORKBENCH_INVALID: scenario.steps')
    expect(parseApiScenario(scenario(steps.slice(0, API_LIMITS.maxScenarioSteps))).steps).toHaveLength(API_LIMITS.maxScenarioSteps)
  })

  test('Given 步骤身份重复 When 解析 Then 拒绝（结果无法与步骤一一对应）', () => {
    const steps = [
      { id: 'step_login', name: '登录', requestId: 'request_login' },
      { id: 'step_login', name: '再登录一次', requestId: 'request_login' },
    ]

    expect(() => parseApiScenario(scenario(steps))).toThrow('API_WORKBENCH_INVALID: scenario.steps.duplicateId')
  })

  test('Given 步骤里内联了请求定义或未知字段 When 解析 Then 拒绝', () => {
    /** 内联 url 会让同一条请求出现两份定义，跑出来的证据无法对人维护的那一份。 */
    expect(() => parseApiScenario(scenario([{ id: 'step_login', name: '登录', requestId: 'request_login', url: 'https://example.test' }])))
      .toThrow('API_WORKBENCH_INVALID: scenario.step')
    expect(() => parseApiScenario(scenario([{ id: 'step_login', name: '登录', requestId: 'request_login', secretRef: 'x' }])))
      .toThrow('API_WORKBENCH_INVALID: scenario.step')
  })

  test('Given 失败策略取值非法 When 解析 Then 拒绝而不是猜', () => {
    expect(() => parseApiScenario({ ...scenario(), onFailure: 'ignore' })).toThrow('API_WORKBENCH_INVALID: scenario.onFailure')
    expect(() => parseApiScenario(scenario([{ id: 'step_login', name: '登录', requestId: 'request_login', onFailure: 'retry' }])))
      .toThrow('API_WORKBENCH_INVALID: scenario.step.onFailure')
  })

  test('Given 场景指向不存在的集合 When 解析目录 Then 拒绝', () => {
    expect(() => parseApiCatalog(catalog({ scenarios: [{ ...scenario(), collectionId: 'missing' }] })))
      .toThrow('API_WORKBENCH_INVALID: scenario.collectionId')
  })

  test('Given 场景引用了已被删除的请求或用例 When 解析目录 Then 仍通过（关系在准备阶段 fail closed）', () => {
    /** 请求可被人在界面删除：目录层不因悬空引用整体不可读，准备时再给出可行动错误。 */
    const raw = scenario([
      { id: 'step_login', name: '登录', requestId: 'request_deleted' },
      { id: 'step_profile', name: '用户详情', requestId: 'request_profile', caseId: 'case_deleted' },
    ])

    const parsed = parseApiCatalog(catalog({ scenarios: [raw] }))

    expect(parsed.scenarios?.[0]?.steps.map((step) => step.requestId)).toEqual(['request_deleted', 'request_profile'])
    expect(parsed.scenarios?.[0]?.steps[1]?.caseId).toBe('case_deleted')
  })

  test('Given 场景数量超过上限 When 解析目录 Then 拒绝', () => {
    const many = Array.from({ length: API_LIMITS.maxScenarios + 1 }, (_value, index) => ({ ...scenario(), id: `scenario_${index}` }))

    expect(() => parseApiCatalog(catalog({ scenarios: many }))).toThrow('API_WORKBENCH_INVALID: scenarios')
  })
})
