import { describe, expect, test } from 'bun:test'
import {
  parseServerOpsConsoleAck,
  parseServerOpsConsoleInput,
  parseServerOpsConsoleResizeInput,
  parseServerOpsConsoleStartInput,
} from './server-ops-console'

const containerId = 'a'.repeat(64)
const identity = { consoleId: 'console-1', hostId: 'host-1', connectionId: 'connection-1', containerId }

describe('Server Ops Docker Console shared 合同', () => {
  test('Given 合法 start/input/resize/ack When 解析 Then 重建完整 Console 身份', () => {
    expect(parseServerOpsConsoleStartInput({ hostId: 'host-1', containerId, cols: 80, rows: 24 }))
      .toEqual({ hostId: 'host-1', containerId, cols: 80, rows: 24 })
    expect(parseServerOpsConsoleInput({ ...identity, data: 'pwd\n' })).toEqual({ ...identity, data: 'pwd\n' })
    expect(parseServerOpsConsoleResizeInput({ ...identity, cols: 120, rows: 40 })).toEqual({ ...identity, cols: 120, rows: 40 })
    expect(parseServerOpsConsoleAck({ ...identity, sequence: 1 })).toEqual({ ...identity, sequence: 1 })
  })

  test.each([
    { hostId: 'host-1', containerId: 'abc', cols: 80, rows: 24 },
    { hostId: 'host-1', containerId, cols: 0, rows: 24 },
    { hostId: 'host-1', containerId, cols: 80, rows: 24, command: '/bin/bash' },
    { ...identity, data: 'x'.repeat(65_537) },
    { ...identity, cols: 80, rows: 24, extra: true },
    { ...identity, sequence: 0 },
  ])('Given 非法或夹带字段 %# When 解析 Then fail closed', (input) => {
    expect(() => {
      if ('command' in input || !('consoleId' in input)) parseServerOpsConsoleStartInput(input)
      else if ('data' in input) parseServerOpsConsoleInput(input)
      else if ('sequence' in input) parseServerOpsConsoleAck(input)
      else parseServerOpsConsoleResizeInput(input)
    }).toThrow()
  })
})
