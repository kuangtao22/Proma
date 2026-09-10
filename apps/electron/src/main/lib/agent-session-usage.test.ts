import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { calculateContextUsageRatio, inferContextWindow } from '@proma/shared'

let sessionPath = ''
const temporaryDirectories: string[] = []

mock.module('./config-paths', () => ({
  getAgentSessionMessagesPath: () => sessionPath,
}))

const { getSessionContextUsageRatio } = await import('./agent-session-usage')

interface UsageStatusCarrier {
  usageStatus?: 'known' | 'partial' | 'unknown'
}

function writeSession(messages: unknown[]): void {
  const directory = mkdtempSync(join(tmpdir(), 'proma-agent-session-usage-'))
  temporaryDirectories.push(directory)
  sessionPath = join(directory, 'session.jsonl')
  writeFileSync(sessionPath, `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`, 'utf-8')
}

function assistant(inputTokens: number, status?: UsageStatusCarrier['usageStatus']): object {
  return {
    type: 'assistant',
    message: {
      content: [],
      model: 'gpt-6-astra',
      usage: { input_tokens: inputTokens, output_tokens: 1 },
      ...(status ? { usageStatus: status } : {}),
    },
  }
}

function result(inputTokens: number, status?: UsageStatusCarrier['usageStatus']): object {
  return {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: inputTokens, output_tokens: 1 },
    ...(status ? { usageStatus: status } : {}),
    modelUsage: { 'gpt-6-astra': { contextWindow: 372_000 } },
  }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  sessionPath = ''
})

describe('Agent 会话上下文用量', () => {
  test('Given 新 result 是部分累计值且同轮有可靠 assistant When 读取占用 Then 使用 assistant 的最后已知上下文', () => {
    writeSession([
      assistant(120, 'known'),
      result(960, 'partial'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 新 result 标记为 known 但其值是累计值 When 同轮有 assistant Then 不以 result 替换 assistant 上下文', () => {
    writeSession([
      assistant(120, 'known'),
      result(960, 'known'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 最新 assistant 用量未知且尚未压缩 When 之前有可靠 assistant Then 保留最后已知上下文', () => {
    writeSession([
      assistant(120, 'known'),
      assistant(0, 'unknown'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(120, inferContextWindow('gpt-6-astra')),
    )
  })

  test('Given 未知用量位于压缩边界之后 When 读取占用 Then 不跨边界复用压缩前的精确值', () => {
    writeSession([
      assistant(120, 'known'),
      { type: 'system', subtype: 'compact_boundary' },
      assistant(0, 'unknown'),
      result(0, 'unknown'),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBeUndefined()
  })

  test('Given 合成压缩 result 没有状态且带零值 When 后面没有 assistant Then 不将其当作真实上下文', () => {
    writeSession([
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 0, output_tokens: 0 },
        isSyntheticCompactionResult: true,
      },
    ])

    expect(getSessionContextUsageRatio('session-1')).toBeUndefined()
  })

  test('Given 旧 JSONL 没有 usageStatus When 读取占用 Then 保留原 result 优先行为', () => {
    writeSession([
      assistant(120),
      result(960),
    ])

    expect(getSessionContextUsageRatio('session-1')).toBe(
      calculateContextUsageRatio(960, 372_000),
    )
  })
})
