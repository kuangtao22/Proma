import { expect, test } from 'bun:test'
import { registerApiWorkbenchIpc } from './api-ipc'
import type { ApiIpcDependencies } from './api-ipc'

/** 最小主进程夹具只替代传输边界，其余输入验证使用生产代码。 */
function fixture(authorized = true) {
  let handler: ((event: { sender: { id: number } }, input: unknown) => Promise<unknown>) | undefined
  let calls = 0
  const service = { getCatalog: async (workspaceId: string) => { calls++; return { version: 1, revision: workspaceId === 'workspace-a' ? 3 : 0, collections: [], environments: [], requests: [] } } } as unknown as ApiIpcDependencies['service']
  registerApiWorkbenchIpc({
    ipc: { handle: (_channel, listener) => { handler = listener }, removeHandler: () => {} },
    service, isAuthorizedSender: () => authorized,
    requireSession: (id) => { if (id !== 'session-a') throw new Error('INVALID_SESSION'); return { id, workspaceId: 'workspace-a' } },
  })
  return { invoke: (input: unknown) => handler!({ sender: { id: 7 } }, input), count: () => calls }
}
test('Given 已授权桌面会话 When 读取目录 Then 由Host解析workspace', async () => {
  const f = fixture()
  expect(await f.invoke({ method: 'getCatalog', input: { sessionId: 'session-a' } })).toMatchObject({ revision: 3 })
  expect(f.count()).toBe(1)
})
test('Given 网页或未知sender When 调用 Then 服务不执行', async () => {
  const f = fixture(false)
  await expect(f.invoke({ method: 'getCatalog', input: { sessionId: 'session-a' } })).rejects.toThrow('API_ACCESS_DENIED')
  expect(f.count()).toBe(0)
})
test('Given 内部或不存在会话 When 调用 Then 服务不执行', async () => {
  const f = fixture()
  await expect(f.invoke({ method: 'getCatalog', input: { sessionId: 'other' } })).rejects.toThrow()
  expect(f.count()).toBe(0)
})
test('Given 注入workspace与路径 When 调用 Then 在服务前拒绝', async () => {
  const f = fixture()
  await expect(f.invoke({ method: 'getCatalog', input: { sessionId: 'session-a', workspaceId: 'other' } })).rejects.toThrow()
  expect(f.count()).toBe(0)
})
