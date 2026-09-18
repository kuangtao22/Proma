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
})
