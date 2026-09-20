import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectStaleDevBundle } from './dev-bundle-freshness'

/** 构造最小目录结构：dist 产物 + 源码目录，并按需设置修改时间。 */
function createFixture(dirs: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-freshness-'))
  mkdirSync(join(root, 'dist'), { recursive: true })
  for (const dir of dirs) mkdirSync(join(root, dir), { recursive: true })
  return root
}

/** 写入文件并指定修改时间（秒级时间戳）。 */
function touch(path: string, seconds: number, content = 'x'): void {
  writeFileSync(path, content)
  utimesSync(path, seconds, seconds)
}

describe('开发态 bundle 新鲜度', () => {
  test('Given 产物早于源码 When 检测 Then 给出可操作告警', () => {
    const root = createFixture(['src/main', 'src/preload', 'packages/shared/src'])
    touch(join(root, 'dist/main.cjs'), 1_000)
    touch(join(root, 'dist/preload.cjs'), 1_000)
    /** 共享合同比产物新，正是「改了共享代码却没重建主进程」的场景。 */
    touch(join(root, 'packages/shared/src/image-generation.ts'), 2_000)
    const warning = detectStaleDevBundle({ root, sourcePaths: ['src/main', 'src/preload', 'packages/shared/src'] })
    expect(warning).not.toBeNull()
    expect(warning ?? '').toContain('dist/main.cjs')
    expect(warning ?? '').toContain('bun run build:main')
  })

  test('Given 产物不早于源码 When 检测 Then 不产生噪音', () => {
    const root = createFixture(['src/main', 'src/preload', 'packages/shared/src'])
    touch(join(root, 'packages/shared/src/image-generation.ts'), 1_000)
    touch(join(root, 'src/main/index.ts'), 1_000)
    touch(join(root, 'dist/main.cjs'), 2_000)
    touch(join(root, 'dist/preload.cjs'), 2_000)
    expect(detectStaleDevBundle({ root, sourcePaths: ['src/main', 'src/preload', 'packages/shared/src'] })).toBeNull()
  })

  test('Given 产物缺失 When 检测 Then 交给 readiness 流程判断而不误报', () => {
    const root = createFixture(['src/main', 'packages/shared/src'])
    touch(join(root, 'packages/shared/src/image-generation.ts'), 2_000)
    expect(detectStaleDevBundle({ root, sourcePaths: ['src/main', 'packages/shared/src'] })).toBeNull()
  })

  test('Given 运行时产物早于 utility 源码 When 检测 Then 点名该产物与重建命令', () => {
    /**
     * 这正是真实踩过的坑：`dist/server-ops-runtime.cjs` 停在旧版本、
     * 而其源码已加上"直连数据源"支持，运行时收到请求后静默丢弃，
     * 界面表现为"连接测试永远超时"。
     */
    const root = createFixture(['src/main', 'src/preload', 'src/utility', 'packages/shared/src'])
    touch(join(root, 'dist/main.cjs'), 3_000)
    touch(join(root, 'dist/preload.cjs'), 3_000)
    touch(join(root, 'dist/server-ops-runtime.cjs'), 1_000)
    touch(join(root, 'dist/agent-runtime.cjs'), 3_000)
    touch(join(root, 'dist/terminal-runtime.cjs'), 3_000)
    mkdirSync(join(root, 'src/utility/server-ops'), { recursive: true })
    touch(join(root, 'src/utility/server-ops/server-ops-data-runtime.ts'), 2_000)

    const warning = detectStaleDevBundle({ root })
    expect(warning).not.toBeNull()
    expect(warning ?? '').toContain('dist/server-ops-runtime.cjs')
    expect(warning ?? '').toContain('bun run build:server-ops-runtime')
    /** 只改 utility 时不得把主进程产物也算成过期，否则告警会变成噪音。 */
    expect(warning ?? '').not.toContain('dist/main.cjs')
  })

  test('Given 只改主进程源码 When 检测 Then 不牵连运行时产物', () => {
    const root = createFixture(['src/main', 'src/preload', 'src/utility', 'packages/shared/src'])
    touch(join(root, 'dist/server-ops-runtime.cjs'), 2_000)
    touch(join(root, 'dist/agent-runtime.cjs'), 2_000)
    touch(join(root, 'dist/terminal-runtime.cjs'), 2_000)
    touch(join(root, 'dist/preload.cjs'), 3_000)
    touch(join(root, 'dist/main.cjs'), 1_000)
    touch(join(root, 'src/main/index.ts'), 2_000)

    const warning = detectStaleDevBundle({ root })
    expect(warning ?? '').toContain('dist/main.cjs')
    expect(warning ?? '').not.toContain('dist/server-ops-runtime.cjs')
  })
})
