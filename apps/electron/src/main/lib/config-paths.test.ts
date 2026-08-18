import { expect, test } from 'bun:test'
import {
  getAgentSessionMessagesPath,
  getConfigDirName,
  getConversationMessagesPath,
  resolveAgentSessionWorkspacePath,
} from './config-paths'

test('Given a development environment When resolving business storage Then it shares the production config directory', () => {
  // 保存调用方环境，避免测试修改影响同进程中的其他用例。
  const originalPromaDev = process.env.PROMA_DEV
  process.env.PROMA_DEV = '1'

  try {
    expect(getConfigDirName()).toBe('.proma')
  } finally {
    if (originalPromaDev === undefined) {
      delete process.env.PROMA_DEV
    } else {
      process.env.PROMA_DEV = originalPromaDev
    }
  }
})

test('Given traversal 消息 ID When 解析 JSONL 路径 Then Agent 与 Conversation 均拒绝越界', () => {
  expect(() => getAgentSessionMessagesPath('../outside')).toThrow('无效的会话 ID')
  expect(() => getConversationMessagesPath('../outside')).toThrow('无效的会话 ID')
})

test('Given the default environment When resolving business storage Then it uses the shared config directory', () => {
  expect(getConfigDirName()).toBe('.proma')
})

test('Given traversal 或绝对 sessionId When 解析会话目录 Then 在文件系统访问前拒绝越界', () => {
  for (const sessionId of ['../outside', 'nested/session', 'nested\\session', '/tmp/outside']) {
    expect(() => resolveAgentSessionWorkspacePath('workspace', sessionId)).toThrow('无效的会话 ID')
  }
})
