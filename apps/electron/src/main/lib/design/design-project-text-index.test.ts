import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createDesignPathResolver } from './design-paths'
import { DesignProjectTextIndex } from './design-project-text-index'

describe('DesignProjectTextIndex', () => {
  /** 每个测试独占的项目根。 */
  let tempRoot: string
  /** 已授权项目文件目录。 */
  let projectRoot: string
  /** 被测增量文本索引。 */
  let index: DesignProjectTextIndex

  /** 在项目内创建文本文件及所需父目录。 */
  function write(relativePath: string, content: string): string {
    /** 由测试固定相对路径解析的目标文件。 */
    const filePath = join(projectRoot, relativePath)
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, content)
    return filePath
  }

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), 'proma-design-text-index-'))
    projectRoot = join(tempRoot, 'project')
    mkdirSync(projectRoot, { recursive: true })
    /** 使用生产路径解析器限制索引只能访问 project-1。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: (projectId) => projectId === 'project-1'
        ? {
            id: 'project-1',
            name: '项目',
            slug: 'project-slug',
            projectRootPath: projectRoot,
            createdAt: 1,
            updatedAt: 1,
          }
        : undefined,
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => join(tempRoot, 'config'),
    })
    index = new DesignProjectTextIndex({ pathResolver })
  })

  afterEach(() => {
    rmSync(tempRoot, { recursive: true, force: true })
  })

  test('Given 项目含源码和敏感文件 When 建立索引 Then 只返回允许的普通文本文件', () => {
    write('src/App.tsx', 'export function App() {}')
    write('.env', 'SECRET=x')
    write('credentials.json', '{"token":"secret"}')
    write('private-key.pem', 'PRIVATE')
    write('node_modules/pkg/index.js', 'ignored')
    write('dist/app.js', 'ignored')
    write('.proma/design/context/documents/brand.md', '# Brand')
    /** 指向项目外秘密文件的叶子符号链接。 */
    const outsideSecret = join(tempRoot, 'outside-secret.ts')
    writeFileSync(outsideSecret, 'export const secret = true')
    symlinkSync(outsideSecret, join(projectRoot, 'src', 'secret-link.ts'))

    /** 搜索结果只包含允许的真实源码。 */
    const entries = index.search('project-1', 'App')

    expect(entries.map((entry) => entry.relativePath)).toEqual(['src/App.tsx'])
    expect(index.list('project-1').map((entry) => entry.relativePath)).toEqual(['src/App.tsx'])
  })

  test('Given 已缓存文件发生替换 When 再次搜索 Then 只更新该文件身份', () => {
    const appPath = write('src/App.tsx', 'old content')
    write('src/Stable.ts', 'stable content')
    /** 首次搜索建立两份文件的元数据缓存。 */
    const firstApp = index.search('project-1', 'old')[0]
    const firstStable = index.search('project-1', 'stable')[0]
    /** 使用 rename 置换文件，确保 dev/ino 身份变化。 */
    const replacementPath = write('src/App.next.tsx', 'new content')
    renameSync(replacementPath, appPath)

    const nextApp = index.search('project-1', 'new')[0]
    const nextStable = index.search('project-1', 'stable')[0]

    expect(nextApp?.identity).not.toBe(firstApp?.identity)
    expect(nextStable?.identity).toBe(firstStable?.identity)
  })

  test('Given 文件在索引后原地变化 When 按缓存身份读取 Then 拒绝本次结果并失效缓存', () => {
    const appPath = write('src/App.tsx', 'old content')
    index.list('project-1')
    writeFileSync(appPath, 'new content with different size')

    expect(() => index.read('project-1', 'src/App.tsx', 64 * 1024)).toThrow('项目文件身份已变化')
    expect(() => index.read('project-1', 'src/App.tsx', 64 * 1024)).toThrow('项目文件尚未建立索引')

    index.invalidate('project-1')
    index.list('project-1')
    expect(index.read('project-1', 'src/App.tsx', 64 * 1024)).toBe('new content with different size')
  })

  test('Given 目录参数或查询含越权语义 When 调用索引 Then 在遍历前拒绝', () => {
    write('src/App.tsx', 'content')

    expect(() => index.list('project-1', '../outside')).toThrow('项目相对目录非法')
    expect(() => index.read('project-1', '/tmp/outside', 100)).toThrow('项目相对路径非法')
    expect(() => index.search('project-1', '')).toThrow('搜索词不能为空')
    expect(() => index.search('project-1', 'x'.repeat(201))).toThrow('搜索词不能超过 200 个字符')
  })

  test('Given 文本文件存在第二个硬链接 When 建立索引 Then 拒绝不稳定的多链接身份', () => {
    const sourcePath = write('src/App.tsx', 'content')
    linkSync(sourcePath, join(projectRoot, 'src', 'App-copy.tsx'))

    expect(index.list('project-1')).toEqual([])
  })

  test('Given 读取上限小于文件内容 When 读取 Then 返回上限内文本且不扩大缓存', () => {
    write('README.md', 'abcdefghij')
    index.list('project-1')

    expect(index.read('project-1', 'README.md', 4)).toBe('abcd')
    expect(index.read('project-1', 'README.md', 0)).toBe('')
  })
})
