import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

/**
 * 运维凭据 Store 的 safeStorage 接线守卫。
 *
 * 这两个 Store 在未注入 `safeStorage` 时会退化成 fail-closed 的占位实现，
 * 表现为"保存密码永远失败"而不是崩溃；曾经真的漏注入过一次（数据库密码），
 * 因此这里对主进程接线做源码级断言。
 */
describe('运维凭据 Store 的 safeStorage 接线', () => {
  test('Given 主进程接线 When 读取 ipc.ts Then 两个凭据 Store 都注入了 safeStorage', () => {
    /** 主进程接线源码。 */
    const source = readFileSync(new URL('./ipc.ts', import.meta.url), 'utf8')
    for (const constructor of ['new ServerOpsCredentialStore(', 'new ServerOpsDataSourceCredentialStore(']) {
      /** 构造点起始位置。 */
      const index = source.indexOf(constructor)
      expect(index).toBeGreaterThan(0)
      /** 构造所在行的完整文本。 */
      const call = source.slice(index, source.indexOf('\n', index))
      expect(call).toContain('safeStorage')
    }
  })
})
