import type { Content } from '@tiptap/core'
import type { FilePanelDragItem } from './file-panel-drag'

/** 允许 TipTap 或测试替身接收文件引用内容的最小边界。 */
export interface FileMentionInsertionTarget {
  /** 当前 editor schema 是否注册 mention 节点。 */
  hasMentionNode: boolean
  /** 将构建好的内容插入 composer，并返回底层命令是否成功。 */
  insertContent: (content: Content) => boolean
}

/** 文件引用最终交给 TipTap 的内容类型。 */
export type FileMentionInsertionContent = Content

/** 将文件引用序列化为现有可发送、可解码的纯文本协议。 */
function serializeFileMentionText(items: FilePanelDragItem[]): string {
  return `${items.map((item) => `@file:${encodeURIComponent(item.path)}`).join(' ')} `
}

/** 构建富文本模式使用的 TipTap mention 节点。 */
function buildFileMentionNodes(items: FilePanelDragItem[]): Content {
  /** 按输入顺序生成 mention 与分隔空格。 */
  const content: Array<Record<string, unknown>> = []
  for (const item of items) {
    content.push({
      type: 'mention',
      attrs: {
        id: item.path,
        label: item.name,
        mentionSuggestionChar: '@',
        isDirectory: item.isDirectory,
      },
    })
    content.push({ type: 'text', text: ' ' })
  }
  return content
}

/**
 * 向 composer 插入文件引用，并把底层命令结果作为消费确认依据。
 * 富文本可用时插入 mention；默认纯文本或 schema 缺失时复用 @file: 协议。
 */
export function insertFileMentionsWithFallback(
  items: FilePanelDragItem[],
  richTextEnabled: boolean,
  target: FileMentionInsertionTarget,
): boolean {
  if (items.length === 0) return false
  /** 只有富文本开关和 schema 同时允许时才生成 mention 节点。 */
  const useMentionNodes = richTextEnabled && target.hasMentionNode
  /** 本次实际交给 editor 的节点或纯文本引用。 */
  const content = useMentionNodes ? buildFileMentionNodes(items) : serializeFileMentionText(items)
  return target.insertContent(content)
}
