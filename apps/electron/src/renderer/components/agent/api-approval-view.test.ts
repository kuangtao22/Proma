import { describe, expect, test } from 'bun:test'
import { describeApiWorkbenchApproval, formatApiApprovalCaseDiff } from './api-approval-view'

/** 宿主组装的最小发送审批快照。 */
const sendInput = {
  preparedId: 'prepared_1',
  preview: { requestName: '登录', environmentId: 'env_test', request: { method: 'POST', url: 'https://example.test/login' } },
  send: { caseId: 'case_human', caseName: '人工写的越权', assertionCount: 1 },
}

describe('接口工作台审批卡视图', () => {
  test('Given 非接口变更工具 When 解析 Then 返回空以便回落到原有展示', () => {
    expect(describeApiWorkbenchApproval('Bash', { command: 'ls' })).toBeNull()
    expect(describeApiWorkbenchApproval('api_inspect_run', { runId: 'run_1' })).toBeNull()
  })

  test('Given 按用例发送 When 解析 Then 显示目标、环境与这组断言', () => {
    const view = describeApiWorkbenchApproval('api_send_request', sendInput)

    expect(view?.kind).toBe('api-send')
    expect(view?.title).toBe('发送接口请求')
    expect(view?.lines).toEqual([
      'POST https://example.test/login',
      '请求名称：登录',
      '环境：env_test',
      '用例：人工写的越权（1 条断言）',
    ])
    expect(view?.files).toEqual([])
    expect(view?.caseDiff).toEqual([])
  })

  test('Given Agent 声明了本机文件 When 解析 Then 逐行给出字段、真实路径与大小', () => {
    const view = describeApiWorkbenchApproval('api_send_request', {
      ...sendInput,
      files: [
        { field: 'file', path: '/Users/ada/secret/id_rsa', sizeBytes: 1675 },
        { field: 'avatar', path: '/Users/ada/图片/头像.png', sizeBytes: 20480 },
      ],
    })

    expect(view?.files.map((file) => file.text)).toEqual([
      '字段 file：/Users/ada/secret/id_rsa（1675 字节）',
      '字段 avatar：/Users/ada/图片/头像.png（20480 字节）',
    ])
    /** 结构化字段与展示文本同源，界面不必再解析字符串。 */
    expect(view?.files[0]).toEqual({ field: 'file', path: '/Users/ada/secret/id_rsa', sizeBytes: 1675, text: '字段 file：/Users/ada/secret/id_rsa（1675 字节）' })
  })

  test('Given 附件行损坏或缺字段 When 解析 Then 丢弃坏项而不是展示半截事实', () => {
    const view = describeApiWorkbenchApproval('api_send_request', {
      ...sendInput,
      files: [
        { field: 'file', path: '/tmp/ok.bin', sizeBytes: 3 },
        { field: 'file', path: '/tmp/missing-size.bin' },
        { field: '', path: '/tmp/no-field.bin', sizeBytes: 1 },
        { field: 'file', path: '/tmp/negative.bin', sizeBytes: -1 },
        'nonsense',
      ],
    })

    expect(view?.files.map((file) => file.path)).toEqual(['/tmp/ok.bin'])
  })

  test('Given 保存审批 When 解析 Then 不展示附件行（保存写的是引用）', () => {
    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { request: { method: 'POST', url: 'https://example.test/upload' } },
      save: { collectionId: 'default' },
      files: [{ field: 'file', path: '/tmp/secret.bin', sizeBytes: 5 }],
    })

    expect(view?.files).toEqual([])
  })

  test('Given 不按用例发送 When 解析 Then 说明用的是请求自身断言', () => {
    const view = describeApiWorkbenchApproval('api_send_request', {
      preview: { request: { method: 'GET', url: 'https://example.test/users' } },
      send: { assertionCount: 2 },
    })

    expect(view?.lines).toEqual(['GET https://example.test/users', '环境：未选择', '断言：请求自身默认断言 2 条'])
  })

  test('Given 保存含用例改动 When 解析 Then 逐条列出新增、修改与删除', () => {
    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { requestName: '登录', request: { method: 'POST', url: 'https://example.test/login' } },
      save: {
        collectionId: 'default',
        caseDiff: [
          { caseId: 'case_new', caseName: 'Agent 补的缺参数', source: 'agent', change: 'added', assertionCount: 1 },
          { caseId: 'case_agent', caseName: 'Agent 改过的用例', source: 'agent', change: 'updated', assertionCount: 2 },
          { caseId: 'case_agent_old', caseName: 'Agent 删掉的用例', source: 'agent', change: 'removed', assertionCount: 0 },
        ],
      },
    })

    expect(view?.lines).toEqual(['POST https://example.test/login', '请求名称：登录', '保存到集合：default'])
    expect(view?.caseDiff.map(formatApiApprovalCaseDiff)).toEqual([
      '新增：Agent 补的缺参数（Agent，1 条断言）',
      '修改：Agent 改过的用例（Agent，2 条断言）',
      '删除：Agent 删掉的用例（Agent，0 条断言）',
    ])
  })

  test('Given 保存没有用例改动 When 解析 Then 明确说明没有改动', () => {
    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { request: { method: 'GET', url: 'https://example.test' } },
      save: { collectionId: 'default' },
    })

    expect(view?.lines).toEqual(['GET https://example.test', '保存到集合：default', '用例：本次没有改动'])
    expect(view?.caseDiff).toEqual([])
  })

  test('Given 保存草稿存在质量劣化 When 解析 Then 把提醒一并列出', () => {
    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { requestName: '[后台] POST /admin/v1/x', request: { method: 'POST', url: 'http://127.0.0.1:18080/admin/v1/x' } },
      save: {
        collectionId: 'default',
        warnings: [
          '「[后台] POST /admin/v1/x」这个名字是「方法 + 路径」生成的，建议改成业务可读名',
          '有 126 条请求都把 http://127.0.0.1:18080 写进 URL：建议在集合或环境里声明一个变量（例如 baseUrl）',
        ],
      },
    })

    expect(view?.warnings).toEqual([
      '「[后台] POST /admin/v1/x」这个名字是「方法 + 路径」生成的，建议改成业务可读名',
      '有 126 条请求都把 http://127.0.0.1:18080 写进 URL：建议在集合或环境里声明一个变量（例如 baseUrl）',
    ])
  })

  test('Given 快照缺字段或损坏 When 解析 Then 不猜测而是丢弃坏项', () => {
    expect(describeApiWorkbenchApproval('api_save_request', {})).toBeNull()
    expect(describeApiWorkbenchApproval('api_save_request', { preview: 'not-object' })).toBeNull()

    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { request: { method: 'GET', url: 'https://example.test' } },
      save: { collectionId: 'default', caseDiff: [{ caseId: 'case_a', caseName: '好的一条', change: 'added', source: 'agent', assertionCount: 1 }, { caseId: 'case_b', change: 'weird' }, 'nonsense'] },
    })

    expect(view?.caseDiff.map((entry) => entry.caseId)).toEqual(['case_a'])
  })

  test('Given 流程运行审批 When 解析 Then 逐行列出步骤、环境与失败策略', () => {
    const view = describeApiWorkbenchApproval('api_run_scenario', {
      preparedId: 'prepared_scenario',
      scenario: {
        preparedId: 'prepared_scenario', scenarioId: 'scenario_login', scenarioName: '登录后看详情', catalogRevision: 5,
        onFailure: 'stop', createdAt: 1, expiresAt: 2,
        warnings: ['流程中有 1 个步骤指向 production 环境，运行前必须逐次复核'],
        steps: [
          { index: 0, stepId: 'step_login', name: '登录', requestId: 'request_login', method: 'POST', url: 'https://example.test/login', assertionCount: 1 },
          { index: 1, stepId: 'step_profile', name: '用户详情', requestId: 'request_profile', caseId: 'case_ok', method: 'GET', url: 'https://example.test/profile', environmentKind: 'production', assertionCount: 2 },
        ],
      },
    })

    expect(view?.kind).toBe('api-scenario-run')
    expect(view?.title).toBe('运行接口流程（一次批准整条流程）')
    expect(view?.lines).toEqual([
      '流程：登录后看详情',
      '环境：未选择',
      '失败策略：stop（失败后跳过后续步骤）',
      '步骤：2 步，严格按顺序执行',
    ])
    expect(view?.steps.map((step) => step.text)).toEqual([
      '1. 登录 · POST https://example.test/login',
      '2. 用户详情 · GET https://example.test/profile（用例 case_ok） ⚠ 生产环境',
    ])
    expect(view?.warnings).toEqual(['流程中有 1 个步骤指向 production 环境，运行前必须逐次复核'])
  })

  test('Given 流程保存审批 When 解析 Then 显示模块、环境与步骤引用的接口身份', () => {
    const view = describeApiWorkbenchApproval('api_save_scenario', {
      /** 与 orchestrator 实际装配一致：保存快照放在 scenarioSave 里。 */
      scenarioSave: {
        expectedRevision: 5,
        scenario: {
          name: '下单主流程', description: '', collectionId: 'default', folder: '订单模块',
          steps: [
            { id: 'step_login', name: '登录', requestId: 'request_login' },
            { id: 'step_order', name: '创建订单', requestId: 'request_orders', caseId: 'case_ok' },
          ],
          onFailure: 'stop', revision: 1, updatedAt: 1,
        },
      },
    })

    expect(view?.kind).toBe('api-scenario-save')
    expect(view?.lines).toEqual(['流程：下单主流程', '保存到集合：default', '模块（文件夹）：订单模块', '环境：未选择', '步骤：2 步'])
    expect(view?.steps.map((step) => step.text)).toEqual(['1. 登录 → request_login', '2. 创建订单 → request_orders（用例 case_ok）'])
  })

  test('Given 流程快照损坏 When 解析 Then 丢弃坏步骤并保持连续序号', () => {
    const view = describeApiWorkbenchApproval('api_run_scenario', {
      scenario: {
        scenarioName: '坏快照流程', onFailure: 'continue', warnings: ['注意 continue'],
        steps: [
          { index: 0, name: '好的步骤', method: 'GET', url: 'https://example.test/a' },
          { index: 1, name: '缺 method', url: 'https://example.test/b' },
          'nonsense',
        ],
      },
    })

    expect(view?.lines).toContain('失败策略：continue（失败后继续执行后续步骤）')
    expect(view?.steps.map((step) => step.text)).toEqual(['1. 好的步骤 · GET https://example.test/a'])
  })
})
