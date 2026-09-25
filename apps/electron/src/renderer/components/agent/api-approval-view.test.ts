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

  test('Given 快照缺字段或损坏 When 解析 Then 不猜测而是丢弃坏项', () => {
    expect(describeApiWorkbenchApproval('api_save_request', {})).toBeNull()
    expect(describeApiWorkbenchApproval('api_save_request', { preview: 'not-object' })).toBeNull()

    const view = describeApiWorkbenchApproval('api_save_request', {
      preview: { request: { method: 'GET', url: 'https://example.test' } },
      save: { collectionId: 'default', caseDiff: [{ caseId: 'case_a', caseName: '好的一条', change: 'added', source: 'agent', assertionCount: 1 }, { caseId: 'case_b', change: 'weird' }, 'nonsense'] },
    })

    expect(view?.caseDiff.map((entry) => entry.caseId)).toEqual(['case_a'])
  })
})
