import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('数据根启动门模块隔离', () => {
  test('Given main 入口尚未通过 normal gate When 静态加载 Then 不求值 LAN Bridge 业务模块', () => {
    /** main 入口源码用于锁定 LAN 组合根只能在 normal bootstrap 内动态加载。 */
    const source = readFileSync(join(import.meta.dir, '..', 'index.ts'), 'utf8')

    expect(source).not.toContain("import { createLanBridgeRegistration } from './lib/lan-bridge/lan-bridge'")
    expect(source).not.toMatch(/^registerBridge\(createLanBridgeRegistration\(agentEventBus\)\)$/m)
    expect(source).toContain("await import('./lib/lan-bridge/lan-bridge')")
    /** dynamic import 必须位于 non-normal 分支的 return 之后。 */
    expect(source.indexOf("await import('./lib/lan-bridge/lan-bridge')"))
      .toBeGreaterThan(source.indexOf("if (dataRootMode !== 'normal')"))
  })

  test('Given LAN Bridge 模块仅被 normal gate 后加载 When 模块求值 Then Auth 与 DeviceStore 仍保持惰性', () => {
    /** LAN 组合模块自身不得在顶层恢复认证服务单例创建。 */
    const source = readFileSync(join(import.meta.dir, 'lan-bridge', 'lan-bridge.ts'), 'utf8')
    expect(source).not.toMatch(/^const lanBridgeAuthService = getLanBridgeAuthService\(\)$/m)
    expect(source).toContain('function ensureLanBridgeAuthService()')
  })
})
