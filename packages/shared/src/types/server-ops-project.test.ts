import { describe, expect, test } from 'bun:test'
import { parseServerOpsProjectCreateInput, parseServerOpsProjectRenameInput } from './server-ops-project'

describe('运维项目名称合同', () => {
  test('Given 合法名称 When 新建或重命名 Then 去掉首尾空白', () => {
    expect(parseServerOpsProjectCreateInput({ name: ' 生产环境 ' })).toEqual({ name: '生产环境' })
    expect(parseServerOpsProjectRenameInput({ projectId: 'project-1', name: ' 测试 ' }).name).toBe('测试')
  })
  test('Given 空白、超长或 C0/C1 控制字符 When 新建或重命名 Then 严格拒绝', () => {
    /** 控制字符既涵盖 ASCII，也涵盖 Unicode C1 范围。 */
    for (const name of ['', ' '.repeat(3), '名'.repeat(61), '项\u0000目', '项\u007f目', '项\u0085目', '项\u009f目']) {
      expect(() => parseServerOpsProjectCreateInput({ name })).toThrow()
      expect(() => parseServerOpsProjectRenameInput({ projectId: 'project-1', name })).toThrow()
    }
  })
})
