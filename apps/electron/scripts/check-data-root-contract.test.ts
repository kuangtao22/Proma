import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { findHardcodedDataRoots, runDataRootContractCli } from './check-data-root-contract'

/** 在隔离仓库中写入主进程 fixture，并返回仓库根。 */
function createFixture(files: Record<string, string>): string {
  /** 当前测试独占的临时仓库根。 */
  const rootDir = mkdtempSync(join(tmpdir(), 'proma-data-root-contract-'))
  for (const [relativePath, content] of Object.entries(files)) {
    /** 当前 fixture 文件的绝对路径。 */
    const absolutePath = join(rootDir, relativePath)
    mkdirSync(dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, content, 'utf8')
  }
  return rootDir
}

describe('数据根合同检查器', () => {
  test('Given 业务模块直接通过 path API 构造默认根 When 扫描主进程 Then 返回稳定去重的 POSIX 相对路径', () => {
    /** 覆盖直接导入、别名和换行三种真实调用形状。 */
    const rootDir = createFixture({
      'apps/electron/src/main/alpha.ts': `
        import { join } from 'node:path'
        import { homedir } from 'node:os'
        export const first = join(homedir(), '.proma')
        export const second = join(homedir(), '.proma')
      `,
      'apps/electron/src/main/nested/beta.ts': `
        import { resolve as resolvePath } from 'node:path'
        import { homedir as getHome } from 'node:os'
        export const root = resolvePath(
          getHome(),
          '.proma',
        )
      `,
      'apps/electron/src/main/default-import.ts': `
        import pathApi from 'node:path'
        import osApi from 'node:os'
        export const joined = pathApi.join(osApi.homedir(), '.proma')
        export const resolved = pathApi.resolve(osApi.homedir(), '.proma')
      `,
    })

    try {
      expect(findHardcodedDataRoots(rootDir)).toEqual([
        'apps/electron/src/main/alpha.ts',
        'apps/electron/src/main/default-import.ts',
        'apps/electron/src/main/nested/beta.ts',
      ])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given 模板、字符串拼接和文件 API 使用硬编码根 When 扫描主进程 Then 全部报告', () => {
    /** 三种不经过 join/resolve 的运行时路径构造。 */
    const rootDir = createFixture({
      'apps/electron/src/main/template.ts': `
        import { readFileSync } from 'node:fs'
        const runtimePath = \`~/.proma/\${segment}\`
        export const content = readFileSync(runtimePath, 'utf8')
      `,
      'apps/electron/src/main/concatenation.ts': `
        import fs from 'node:fs'
        const configPath = '~/.proma/' + fileName
        export const content = fs.readFileSync(configPath, 'utf8')
      `,
      'apps/electron/src/main/string-path.ts': `
        import { readFileSync } from 'node:fs'
        export const settings = readFileSync('~/.proma/settings.json', 'utf8')
      `,
    })

    try {
      expect(findHardcodedDataRoots(rootDir)).toEqual([
        'apps/electron/src/main/concatenation.ts',
        'apps/electron/src/main/string-path.ts',
        'apps/electron/src/main/template.ts',
      ])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given 硬编码路径经局部常量流入 Electron shell sink When 扫描主进程 Then 报告调用文件', () => {
    /** named alias、default 与 namespace 三种 Electron import 都必须按 binding 识别。 */
    const rootDir = createFixture({
      'apps/electron/src/main/named-shell.ts': `
        import { shell as appShell } from 'electron'
        const dataRoot = '~/.proma'
        appShell.openPath(dataRoot)
      `,
      'apps/electron/src/main/default-electron.ts': `
        import electronApi from 'electron'
        electronApi.shell.openPath('~/.proma/settings.json')
      `,
      'apps/electron/src/main/namespace-electron.ts': `
        import * as electronApi from 'electron'
        electronApi.shell.openPath('~/.proma')
      `,
    })

    try {
      expect(findHardcodedDataRoots(rootDir)).toEqual([
        'apps/electron/src/main/default-electron.ts',
        'apps/electron/src/main/named-shell.ts',
        'apps/electron/src/main/namespace-electron.ts',
      ])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given 仅有说明文本、测试和权威边界 When 扫描主进程 Then 不误报', () => {
    /** 注释、JSDoc、用户可见文本与精确白名单都不构成业务路径绕过。 */
    const rootDir = createFixture({
      'apps/electron/src/main/explanation.ts': `
        /** 配置默认位于 ~/.proma/settings.json。 */
        export const help = '请检查 ~/.proma 是否可访问'
        export const pathMessage = '数据存储在 ~/.proma/ 目录'
        export const configHelp = '请删除 ~/.proma/settings.json 后重试'
        export const dialogMessage =
          '常见原因：\\n' +
          '1. ~/.proma/ 配置损坏（重命名 ~/.proma 后重启）\\n' +
          '2. 删除 ~/.proma/feishu.json 后重新登录'
        console.log('数据存储在 ~/.proma')
      `,
      'apps/electron/src/main/shadowed-sink.ts': `
        import { readFileSync } from 'node:fs'
        export function explain(readFileSync: (message: string) => void): void {
          readFileSync('请查看 ~/.proma 后重试')
        }
      `,
      'apps/electron/src/main/feature.test.ts': `
        import { join } from 'node:path'
        import { homedir } from 'node:os'
        const fixture = join(homedir(), '.proma')
      `,
      'apps/electron/src/main/lib/data-root-locator.ts': `
        import { join } from 'node:path'
        export const root = join(homeDir, '.proma')
      `,
      'apps/electron/src/main/lib/data-root-marker.ts': `
        import { join } from 'node:path'
        export const controlledDefault = join(homeDir, '.proma')
      `,
    })

    try {
      expect(findHardcodedDataRoots(rootDir)).toEqual([])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given 主进程目录无法读取 When 扫描合同 Then 明确抛出错误', () => {
    /** 不含扫描目录的临时仓库用于验证 fail closed。 */
    const rootDir = mkdtempSync(join(tmpdir(), 'proma-data-root-contract-missing-'))
    try {
      expect(() => findHardcodedDataRoots(rootDir)).toThrow('apps/electron/src/main')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given 主进程源码存在语法错误 When 扫描合同 Then API 与 CLI 都 fail closed', () => {
    /** 语法损坏文件不能因 AST 容错恢复而静默通过。 */
    const rootDir = createFixture({
      'apps/electron/src/main/broken.ts': 'export const broken = ;',
    })
    /** 捕获 CLI 的明确语法诊断。 */
    const errors: string[] = []

    try {
      expect(() => findHardcodedDataRoots(rootDir)).toThrow('apps/electron/src/main/broken.ts')
      expect(() => findHardcodedDataRoots(rootDir)).toThrow('语法')
      expect(runDataRootContractCli(rootDir, {
        log: () => undefined,
        error: (message) => errors.push(message),
      })).toBe(1)
      expect(errors.join('\n')).toContain('apps/electron/src/main/broken.ts')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given CLI 扫描到违规文件 When 执行检查 Then 逐项输出并返回非零', () => {
    /** 单一违规 fixture 用于锁定 CLI 输出与退出码。 */
    const rootDir = createFixture({
      'apps/electron/src/main/unsafe.ts': `
        import * as path from 'node:path'
        import * as os from 'node:os'
        export const root = path.join(os.homedir(), '.proma')
      `,
    })
    /** 捕获 CLI 普通输出。 */
    const logs: string[] = []
    /** 捕获 CLI 错误输出。 */
    const errors: string[] = []

    try {
      expect(runDataRootContractCli(rootDir, {
        log: (message) => logs.push(message),
        error: (message) => errors.push(message),
      })).toBe(1)
      expect(logs).toEqual([])
      expect(errors.join('\n')).toContain('apps/electron/src/main/unsafe.ts')
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })

  test('Given CLI 未发现违规 When 执行检查 Then 输出通过并返回零', () => {
    /** 合法业务模块不直接构造数据根。 */
    const rootDir = createFixture({
      'apps/electron/src/main/safe.ts': `export const root = getConfigDir()`,
    })
    /** 捕获 CLI 普通输出。 */
    const logs: string[] = []

    try {
      expect(runDataRootContractCli(rootDir, {
        log: (message) => logs.push(message),
        error: () => undefined,
      })).toBe(0)
      expect(logs).toEqual(['数据根合同检查通过'])
    } finally {
      rmSync(rootDir, { recursive: true, force: true })
    }
  })
})
