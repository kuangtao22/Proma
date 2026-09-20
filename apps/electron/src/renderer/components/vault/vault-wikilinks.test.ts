import { describe, expect, test } from 'bun:test'
import { EditorState } from '@codemirror/state'
import {
  canRenderVaultWikiLink,
  isVaultFileNotFoundError,
  openVaultWikiLink,
  parseVaultWikiLink,
  resolveVaultWikiLink,
} from './vault-wikilinks'

describe('Vault 双链解析', () => {
  test('Given 双链包含别名 When 解析显示内容 Then 跳转目标与显示文本保持独立', () => {
    expect(parseVaultWikiLink('[[docs/guide|使用指南]]')).toEqual({
      target: 'docs/guide',
      label: '使用指南',
    })
    expect(parseVaultWikiLink('[[docs/guide]]')).toEqual({
      target: 'docs/guide',
      label: 'docs/guide',
    })
  })

  test('Given 根路径与当前目录都有同名笔记 When 解析普通路径 Then 根路径精确命中优先', () => {
    /** 同时包含根目录、当前目录和其他目录同名笔记的文件树。 */
    const files = ['guide.md', 'projects/guide.md', 'archive/guide.md']

    expect(resolveVaultWikiLink('guide', 'projects/current.md', files)).toBe('guide.md')
  })

  test('Given 普通名称只有当前目录命中 When 解析 Then 打开当前目录笔记', () => {
    /** 只有当前目录包含目标名称的文件树。 */
    const files = ['projects/guide.md', 'archive/other.md']

    expect(resolveVaultWikiLink('guide', 'projects/current.md', files)).toBe('projects/guide.md')
  })

  test('Given 普通名称仅有一个后缀命中 When 解析 Then 打开唯一同名笔记', () => {
    /** 全 Vault 中只有一个目标名称后缀命中的文件树。 */
    const files = ['archive/guide.md', 'projects/other.md']

    expect(resolveVaultWikiLink('guide.md', 'projects/current.md', files)).toBe('archive/guide.md')
  })

  test('Given 普通名称存在多个后缀命中 When 解析 Then 拒绝猜测同名笔记', () => {
    /** 包含两个不同目录同名目标的歧义文件树。 */
    const files = ['archive/guide.md', 'notes/guide.md']

    expect(resolveVaultWikiLink('guide', 'projects/current.md', files)).toBeNull()
  })

  test('Given 显式相对路径 When 解析 Then 仅按当前目录归一化并禁止越出 Vault', () => {
    /** 覆盖当前目录、父级目录和根目录候选的相对路径文件树。 */
    const files = ['projects/guide.md', 'shared/index.md', 'guide.md']

    expect(resolveVaultWikiLink('./guide', 'projects/current.md', files)).toBe('projects/guide.md')
    expect(resolveVaultWikiLink('../shared/index', 'projects/current.md', files)).toBe('shared/index.md')
    expect(resolveVaultWikiLink('../../guide', 'projects/current.md', files)).toBeNull()
  })

  test('Given 双链包含标题锚点、块引用或协议分隔符 When 解析 Then 保持源码且不跳转', () => {
    /** 用于证明特殊目标即使基础笔记存在也不会跳转的文件树。 */
    const files = ['guide.md']

    expect(resolveVaultWikiLink('guide#安装', 'current.md', files)).toBeNull()
    expect(resolveVaultWikiLink('guide^步骤', 'current.md', files)).toBeNull()
    expect(resolveVaultWikiLink('https://example.com', 'current.md', files)).toBeNull()
  })
})

describe('Vault 双链显示边界', () => {
  test('Given 普通正文、嵌入或转义双链 When 判断显示 Then 只替换普通正文', () => {
    /** 普通正文双链的编辑器状态。 */
    const plain = EditorState.create({ doc: '[[guide]]' })
    /** Obsidian 嵌入语法的编辑器状态。 */
    const embedded = EditorState.create({ doc: '![[guide]]' })
    /** 反斜杠转义双链的编辑器状态。 */
    const escaped = EditorState.create({ doc: String.raw`\[[guide]]` })

    expect(canRenderVaultWikiLink(plain, 0)).toBe(true)
    expect(canRenderVaultWikiLink(embedded, 1)).toBe(false)
    expect(canRenderVaultWikiLink(escaped, 1)).toBe(false)
  })

  test('Given 已闭合的 YAML Properties When 判断其中双链 Then 不替换属性源码', () => {
    /** 同时包含 Properties 和普通正文双链的编辑器状态。 */
    const state = EditorState.create({ doc: '---\nrelated: [[guide]]\n---\n正文 [[guide]]' })

    expect(canRenderVaultWikiLink(state, state.doc.line(2).from + 'related: '.length)).toBe(false)
    expect(canRenderVaultWikiLink(state, state.doc.line(4).from + '正文 '.length)).toBe(true)
  })
})

describe('Vault 双链失效目标刷新', () => {
  test('Given 文件树仍包含已删除笔记 When 打开返回 Vault 文件不存在 Then 触发刷新判定', () => {
    expect(isVaultFileNotFoundError(new Error('Vault 文件不存在: archive/deleted.md'))).toBe(true)
    expect(isVaultFileNotFoundError(new Error('读取 Vault 文件失败'))).toBe(false)
    expect(isVaultFileNotFoundError('Vault 文件不存在: archive/deleted.md')).toBe(false)
  })
})

describe('Vault 双链异步导航', () => {
  test('Given 双链命中笔记 When 打开仍在进行 Then 导航结果等待现有打开链路完成', async () => {
    /** 手动结束异步打开操作的测试控制器。 */
    let finishOpen: (() => void) | undefined
    /** 记录导航实际提交给 Vault 打开链路的路径。 */
    const openedPaths: string[] = []
    /** 等待现有 Vault 打开链路完成的双链导航 Promise。 */
    const navigation = openVaultWikiLink({
      target: 'guide',
      source: 'projects/current.md',
      files: ['projects/guide.md'],
      onOpen: (relativePath) => {
        openedPaths.push(relativePath)
        return new Promise<void>((resolve) => { finishOpen = resolve })
      },
      onMissing: () => { throw new Error('命中目标时不应提示缺失') },
    })
    /** 标记导航 Promise 是否已经结束，用于验证不会提前完成。 */
    let settled = false
    void navigation.then(() => { settled = true })

    await Promise.resolve()
    expect(openedPaths).toEqual(['projects/guide.md'])
    expect(settled).toBe(false)

    finishOpen?.()
    await expect(navigation).resolves.toBe(true)
  })

  test('Given 双链目标歧义 When 导航 Then 不启动异步打开并报告原始目标', async () => {
    /** 记录无法解析时传给用户提示的原始目标。 */
    const missingTargets: string[] = []
    /** 记录歧义目标是否错误启动了打开链路。 */
    let openCount = 0

    await expect(openVaultWikiLink({
      target: 'guide',
      source: 'projects/current.md',
      files: ['archive/guide.md', 'notes/guide.md'],
      onOpen: async () => { openCount += 1 },
      onMissing: (target) => { missingTargets.push(target) },
    })).resolves.toBe(false)
    expect(openCount).toBe(0)
    expect(missingTargets).toEqual(['guide'])
  })
})
