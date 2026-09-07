import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchServerOpsTrust } from './server-ops-trust-watcher'

test('Given 配置监听 When 信任文件更新 Then 对账当前连接且释放后不保留 watcher', async () => {
  /** 所有监听仅使用临时数据根，不接触用户业务文件。 */
  const configDir = mkdtempSync(join(tmpdir(), 'proma-trust-watch-'))
  mkdirSync(join(configDir, 'server-ops'))
  const changed = Promise.withResolvers<void>()
  let armed = false
  let unavailable = false
  const close = watchServerOpsTrust({ configDir,
    reconcile: () => { if (armed) changed.resolve() }, unavailable: () => { unavailable = true },
  })
  try {
    /** Bun 的 macOS watcher 在下一轮事件循环完成原生注册。 */
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    armed = true
    writeFileSync(join(configDir, 'server-ops', 'known-hosts.json'), '{}')
    await changed.promise
    expect(unavailable).toBe(false)
    close()
    close()
  } finally { close(); rmSync(configDir, { recursive: true, force: true }) }
}, 3000)

test('Given 监听中的目录被换位 When 同名新目录出现 Then 失效而不继续相信旧监听', async () => {
  const configDir = mkdtempSync(join(tmpdir(), 'proma-trust-watch-'))
  mkdirSync(join(configDir, 'server-ops'))
  const unavailable = Promise.withResolvers<void>()
  const close = watchServerOpsTrust({ configDir, reconcile: () => undefined, unavailable: () => unavailable.resolve() })
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 30))
    renameSync(join(configDir, 'server-ops'), join(configDir, 'retired'))
    mkdirSync(join(configDir, 'server-ops'))
    await unavailable.promise
    close()
  } finally { close(); rmSync(configDir, { recursive: true, force: true }) }
}, 3000)
