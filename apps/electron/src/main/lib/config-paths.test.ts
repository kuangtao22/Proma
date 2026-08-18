import { expect, test } from 'bun:test'
import { getConfigDirName } from './config-paths'

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

test('Given the default environment When resolving business storage Then it uses the shared config directory', () => {
  expect(getConfigDirName()).toBe('.proma')
})
