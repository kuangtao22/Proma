import { describe, expect, test } from 'bun:test'
import type { FilePanelDragItem } from './file-panel-drag'
import {
  insertFileMentionsWithFallback,
  type FileMentionInsertionContent,
} from './file-mention-insertion'

/** 创建包含空格路径的设计素材引用。 */
function createMention(): FilePanelDragItem {
  return {
    path: '/project/.proma/design/assets/My poster.png',
    name: 'My poster.png',
    isDirectory: false,
    scope: 'project',
  }
}

describe('文件引用插入 composer', () => {
  test('Given 富文本开启且 mention 扩展可用 When 插入文件引用 Then 写入合法 mention 节点', () => {
    /** 记录交给 TipTap chain 的真实内容结构。 */
    const inserted: { value: FileMentionInsertionContent | null } = { value: null }

    const success = insertFileMentionsWithFallback([createMention()], true, {
      hasMentionNode: true,
      insertContent: (content) => { inserted.value = content; return true },
    })

    expect(success).toBe(true)
    expect(inserted.value).toEqual([
      {
        type: 'mention',
        attrs: {
          id: '/project/.proma/design/assets/My poster.png',
          label: 'My poster.png',
          mentionSuggestionChar: '@',
          isDirectory: false,
        },
      },
      { type: 'text', text: ' ' },
    ])
  })

  test('Given 富文本关闭或 mention 扩展不可用 When 插入文件引用 Then 写入可见且可发送的既有 @file 协议文本', () => {
    /** 分别记录默认纯文本模式和无扩展模式写入的内容。 */
    const inserted: FileMentionInsertionContent[] = []
    const target = {
      hasMentionNode: true,
      insertContent: (content: FileMentionInsertionContent): boolean => { inserted.push(content); return true },
    }

    expect(insertFileMentionsWithFallback([createMention()], false, target)).toBe(true)
    expect(insertFileMentionsWithFallback([createMention()], true, { ...target, hasMentionNode: false })).toBe(true)
    expect(inserted).toEqual([
      '@file:%2Fproject%2F.proma%2Fdesign%2Fassets%2FMy%20poster.png ',
      '@file:%2Fproject%2F.proma%2Fdesign%2Fassets%2FMy%20poster.png ',
    ])
  })

  test('Given 底层 editor 拒绝插入 When 执行 Then 返回失败状态', () => {
    expect(insertFileMentionsWithFallback([createMention()], false, {
      hasMentionNode: false,
      insertContent: () => false,
    })).toBe(false)
  })
})
