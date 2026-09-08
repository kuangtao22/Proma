import * as React from 'react'
import { EditorState, StateEffect, type Extension, type Range } from '@codemirror/state'
import {
  Decoration,
  EditorView,
  ViewPlugin,
  drawSelection,
  highlightSpecialChars,
  lineNumbers,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { highlightCode, highlightToTokens } from '@proma/core'
import { cn } from '@/lib/utils'

export interface JsonCodeEditorProps {
  value: string
  className?: string
}

export interface VisibleJsonLine {
  number: number
  from: number
  text: string
}

interface VisibleRange {
  from: number
  to: number
}

/** 内部 textbox 的无障碍属性，保持只读内容可聚焦、可选择和可键盘滚动。 */
export const JSON_CODE_EDITOR_CONTENT_ATTRIBUTES = {
  'aria-label': '完整工作流 JSON',
  'aria-readonly': 'true',
  spellcheck: 'false',
  tabindex: '0',
} as const

/** 通知高亮插件重新读取当前视口，不携带或复制完整文档。 */
const refreshJsonHighlightEffect = StateEffect.define<null>()

/** 返回与可见范围相交的文档行，供视口级 JSON 高亮使用。 */
export function collectVisibleJsonLines(
  state: EditorState,
  visibleRanges: readonly VisibleRange[],
): VisibleJsonLine[] {
  /** 记录已经收集的行号，避免重叠可见范围重复生成装饰。 */
  const collectedLineNumbers = new Set<number>()
  /** 按文档顺序保存当前需要高亮的少量行。 */
  const lines: VisibleJsonLine[] = []

  for (const range of visibleRanges) {
    /** 将外部范围限制在当前文档边界内。 */
    const from = Math.max(0, Math.min(range.from, state.doc.length))
    const to = Math.max(from, Math.min(range.to, state.doc.length))
    /** CodeMirror 文档行可避免将大型 JSON 全文转成字符串。 */
    let line = state.doc.lineAt(from)
    const lastLineNumber = state.doc.lineAt(to).number

    while (line.number <= lastLineNumber) {
      if (!collectedLineNumbers.has(line.number)) {
        collectedLineNumbers.add(line.number)
        lines.push({ number: line.number, from: line.from, text: line.text })
      }
      if (line.number === state.doc.lines) break
      line = state.doc.line(line.number + 1)
    }
  }

  return lines
}

/** 根据根节点主题选择已内置的 Shiki 明暗主题。 */
function getJsonHighlightTheme(): string {
  return document.documentElement.classList.contains('dark') ? 'github-dark' : 'github-light'
}

/** 仅为当前可见行生成 token 装饰，避免大工作流产生全量高亮开销。 */
function createVisibleJsonDecorations(view: EditorView, theme: string): DecorationSet {
  /** 收集已按文档顺序排列的装饰范围。 */
  const ranges: Range<Decoration>[] = []

  for (const line of collectVisibleJsonLines(view.state, view.visibleRanges)) {
    /** Shiki 尚未完成懒加载时保留纯文本，加载完成后插件会主动刷新。 */
    const highlighted = highlightToTokens({ code: line.text, language: 'json', theme })
    const tokens = highlighted?.lines[0]
    if (!tokens) continue

    /** tokenOffset 对应当前行内字符偏移。 */
    let tokenOffset = 0
    for (const token of tokens) {
      const from = line.from + tokenOffset
      const to = from + token.content.length
      if (token.color && from < to) {
        ranges.push(Decoration.mark({ attributes: { style: `color: ${token.color}` } }).range(from, to))
      }
      tokenOffset += token.content.length
    }
  }

  return Decoration.set(ranges, true)
}

/** CodeMirror 视口插件：响应滚动、文档和主题变化，并负责释放观察器。 */
const visibleJsonHighlight = ViewPlugin.fromClass(class {
  decorations: DecorationSet
  /** 当前主题决定 Shiki token 颜色。 */
  private theme = getJsonHighlightTheme()
  /** 标记异步高亮初始化完成前组件是否已卸载。 */
  private destroyed = false
  /** 监听应用深浅主题类名切换。 */
  private readonly themeObserver: MutationObserver

  constructor(private readonly view: EditorView) {
    this.decorations = createVisibleJsonDecorations(view, this.theme)
    this.themeObserver = new MutationObserver(() => {
      const nextTheme = getJsonHighlightTheme()
      if (nextTheme === this.theme) return
      this.theme = nextTheme
      this.view.dispatch({ effects: refreshJsonHighlightEffect.of(null) })
    })
    this.themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })

    void highlightCode({ code: '{}', language: 'json', theme: this.theme })
      .then(() => {
        if (!this.destroyed) this.view.dispatch({ effects: refreshJsonHighlightEffect.of(null) })
      })
      .catch(() => {
        // 高亮失败时继续以可复制的纯文本展示完整 JSON。
      })
  }

  update(update: ViewUpdate): void {
    /** 显式刷新事务用于高亮器就绪或主题变化。 */
    const needsExplicitRefresh = update.transactions.some((transaction) =>
      transaction.effects.some((effect) => effect.is(refreshJsonHighlightEffect)),
    )
    if (update.docChanged || update.viewportChanged || needsExplicitRefresh) {
      this.decorations = createVisibleJsonDecorations(update.view, this.theme)
    }
  }

  destroy(): void {
    this.destroyed = true
    this.themeObserver.disconnect()
  }
}, {
  decorations: (plugin) => plugin.decorations,
})

/** 定义只读 JSON 查看器的稳定布局与主题变量。 */
const jsonCodeEditorTheme = EditorView.theme({
  '&': {
    height: '100%',
    minHeight: '0',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
    fontSize: '13px',
  },
  '.cm-scroller': {
    overflow: 'auto',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
    lineHeight: '1.55',
  },
  '.cm-content': {
    minWidth: 'max-content',
    padding: '10px 0',
    caretColor: 'transparent',
  },
  '.cm-line': { padding: '0 14px' },
  '.cm-gutters': {
    backgroundColor: 'hsl(var(--muted) / 0.45)',
    color: 'hsl(var(--muted-foreground))',
    borderRight: '1px solid hsl(var(--border))',
  },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 10px 0 12px' },
  '.cm-selectionBackground': { backgroundColor: 'hsl(var(--accent)) !important' },
  '&.cm-focused': { outline: 'none' },
  '.cm-content ::selection': { backgroundColor: 'hsl(var(--accent))' },
})

/** 组装只读、可选择复制且支持双向滚动的 CodeMirror 扩展。 */
function createJsonCodeEditorExtensions(): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of(JSON_CODE_EDITOR_CONTENT_ATTRIBUTES),
    lineNumbers(),
    highlightSpecialChars(),
    drawSelection(),
    visibleJsonHighlight,
    jsonCodeEditorTheme,
  ]
}

/** 用 CodeMirror 虚拟化展示大型只读 JSON，并在卸载时释放编辑器资源。 */
export function JsonCodeEditor({ value, className }: JsonCodeEditorProps): React.ReactElement {
  /** 承载 CodeMirror DOM 的稳定节点。 */
  const hostRef = React.useRef<HTMLDivElement>(null)
  /** 保存当前 EditorView，供 value 变化时原位更新。 */
  const editorViewRef = React.useRef<EditorView | null>(null)
  /** 保存已经写入编辑器的值，避免为比较而复制大型文档。 */
  const appliedValueRef = React.useRef(value)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host) return

    /** 当前组件唯一的 CodeMirror 实例。 */
    const editorView = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: value,
        extensions: createJsonCodeEditorExtensions(),
      }),
    })
    editorViewRef.current = editorView
    appliedValueRef.current = value

    return () => {
      editorViewRef.current = null
      editorView.destroy()
    }
  }, [])

  React.useEffect(() => {
    const editorView = editorViewRef.current
    if (!editorView || appliedValueRef.current === value) return
    editorView.dispatch({ changes: { from: 0, to: editorView.state.doc.length, insert: value } })
    appliedValueRef.current = value
  }, [value])

  return (
    <div
      ref={hostRef}
      data-json-code-editor="true"
      role="region"
      aria-label="完整工作流 JSON"
      className={cn('min-h-0 overflow-hidden rounded-md border border-border bg-background', className)}
    />
  )
}
