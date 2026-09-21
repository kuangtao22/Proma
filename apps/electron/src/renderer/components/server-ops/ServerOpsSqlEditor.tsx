import * as React from 'react'
import { Compartment, EditorState, Prec, StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers, placeholder, tooltips } from '@codemirror/view'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { MySQL, SQLite, sql } from '@codemirror/lang-sql'
import { acceptCompletion, autocompletion, closeCompletion, closeBrackets, closeBracketsKeymap, startCompletion } from '@codemirror/autocomplete'
import type { CompletionSource } from '@codemirror/autocomplete'
import type { ServerOpsSqlEditorDiagnostic } from './server-ops-sql-validation'
import type { ServerOpsSqlDialect } from './server-ops-sql-completion'

/** 历史回填通过此窄接口聚焦编辑器，不泄漏内部文档状态。 */
export interface ServerOpsSqlEditorHandle {
  focus: () => void
  /** 点击诊断时定位对应区间，不改变 SQL 或撤销历史。 */
  reveal: (diagnostic: ServerOpsSqlEditorDiagnostic) => void
}

/** 编辑器只负责输入；执行、缓存与查询历史由所属查询面板管理。 */
interface ServerOpsSqlEditorProps {
  id: string
  value: string
  contextKey: string
  completionSource: CompletionSource
  diagnostics: ServerOpsSqlEditorDiagnostic[]
  diagnosticsId: string
  /** 当前数据源的 SQL 方言。 */
  dialect: ServerOpsSqlDialect
  onChange: (value: string) => void
  onExecute: () => void
  onCompositionChange: (composing: boolean) => void
}

/** 更新诊断只改变标记，普通输入事务则立即清掉旧位置，避免防抖期间误标。 */
const setSqlDiagnostics = StateEffect.define<ServerOpsSqlEditorDiagnostic[]>()
const sqlDiagnostics = StateField.define<ServerOpsSqlEditorDiagnostic[]>({
  create: () => [],
  update: (current, transaction) => {
    /** 编辑发生后旧文本诊断立即失效，新的结果由所属 Pane 发布。 */
    let next = transaction.docChanged ? [] : current
    for (const effect of transaction.effects) if (effect.is(setSqlDiagnostics)) next = effect.value
    return next
  },
  provide: (field) => [
    EditorView.decorations.from(field, (diagnostics) => Decoration.set(diagnostics.filter((diagnostic) => diagnostic.to > diagnostic.from).map((diagnostic) => Decoration.mark({ class: `cm-sql-diagnostic-${diagnostic.severity}`, attributes: { title: diagnostic.message } }).range(diagnostic.from, diagnostic.to)), true)),
    EditorView.contentAttributes.from(field, (diagnostics) => ({ 'aria-invalid': diagnostics.some((diagnostic) => diagnostic.severity === 'error') ? 'true' : 'false' })),
  ],
})

/** 使用 Proma 主题变量，避免为深浅主题维护两套编辑器实例。 */
const sqlEditorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '12px', color: 'hsl(var(--foreground))', backgroundColor: 'transparent' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace', lineHeight: '2' },
  '.cm-content': { padding: '8px 0', caretColor: 'hsl(var(--foreground))' },
  '.cm-line': { padding: '0 12px' },
  '.cm-gutters': { backgroundColor: 'hsl(var(--muted) / 0.2)', color: 'hsl(var(--muted-foreground) / 0.6)', border: 'none' },
  '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px' },
  '.cm-activeLine': { backgroundColor: 'hsl(var(--muted) / 0.25)' },
  '.cm-cursor': { borderLeftColor: 'hsl(var(--foreground))' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'hsl(var(--accent) / 0.75)' },
  '.cm-placeholder': { color: 'hsl(var(--muted-foreground) / 0.5)' },
  '.cm-tooltip': { zIndex: '280', border: '1px solid hsl(var(--border))', borderRadius: '8px', backgroundColor: 'hsl(var(--popover))', color: 'hsl(var(--popover-foreground))', boxShadow: '0 8px 24px rgb(0 0 0 / 0.12)', fontSize: '12px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { maxHeight: '220px', maxWidth: 'min(32rem, 85vw)', fontFamily: 'inherit' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { backgroundColor: 'hsl(var(--accent))', color: 'hsl(var(--accent-foreground))' },
  '.cm-completionDetail': { fontSize: '11px', marginLeft: '16px', color: 'hsl(var(--muted-foreground))' },
  '.cm-completionInfo': { padding: '8px 10px', maxWidth: 'min(22rem, 70vw)', whiteSpace: 'pre-wrap' },
  '.cm-matchingBracket': { backgroundColor: 'hsl(var(--accent))', outline: '1px solid hsl(var(--border))' },
  '.cm-sql-keyword': { color: 'var(--sql-keyword, #8250df)' },
  '.cm-sql-string': { color: 'var(--sql-string, #116329)' },
  '.cm-sql-number': { color: 'var(--sql-number, #0550ae)' },
  '.cm-sql-comment': { color: 'hsl(var(--muted-foreground))', fontStyle: 'italic' },
  '.cm-sql-diagnostic-error': { textDecoration: 'underline wavy hsl(var(--destructive))', textUnderlineOffset: '4px' },
  '.cm-sql-diagnostic-warning': { textDecoration: 'underline dotted #b7791f', textUnderlineOffset: '4px' },
  /** CodeMirror 在 IME 期间保护组合节点，先隐藏旧标记，避免修改该节点打断组词。 */
  '&.cm-sql-composing .cm-sql-diagnostic-error, &.cm-sql-composing .cm-sql-diagnostic-warning': { textDecoration: 'none' },
})

/** 高亮样式使用 CSS 变量，让应用切换主题后立即生效。 */
const sqlHighlight = HighlightStyle.define([
  { tag: tags.keyword, class: 'cm-sql-keyword' },
  { tag: tags.string, class: 'cm-sql-string' },
  { tag: [tags.number, tags.bool, tags.null], class: 'cm-sql-number' },
  { tag: tags.comment, class: 'cm-sql-comment' },
])

/** 包装 CodeMirror 可控输入；value 和补全源改变时原位更新，不重建视图。 */
export const ServerOpsSqlEditor = React.forwardRef<ServerOpsSqlEditorHandle, ServerOpsSqlEditorProps>(function ServerOpsSqlEditor(props, ref) {
  /** DOM、视图与回调分别保持稳定，避免键入时卸载编辑器或丢失选区。 */
  const hostRef = React.useRef<HTMLDivElement>(null)
  const viewRef = React.useRef<EditorView | null>(null)
  const propsRef = React.useRef(props)
  propsRef.current = props
  /** Compartment 只替换补全扩展，保留文档/撤销历史/滚动位置。 */
  const completionCompartment = React.useMemo(() => new Compartment(), [])
  const contextRef = React.useRef(props.contextKey)
  const applyingExternal = React.useRef(false)
  React.useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    reveal: (diagnostic) => {
      /** 点击时再限制范围，防止刚输入后的旧点击事件访问越界位置。 */
      const view = viewRef.current
      if (!view) return
      const from = Math.min(diagnostic.from, view.state.doc.length)
      const to = Math.min(diagnostic.to, view.state.doc.length)
      view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true })
      view.focus()
    },
  }), [])

  React.useEffect(() => {
    const parent = hostRef.current
    if (!parent) return
    /** 自定义执行快捷键优先于普通换行，并显式排除输入法组合期间。 */
    const shortcuts = Prec.highest(keymap.of([
      { key: 'Mod-Enter', run: (view) => { if (view.composing || view.compositionStarted) return true; propsRef.current.onExecute(); return true } },
      { key: 'Tab', run: acceptCompletion },
      { key: 'Escape', run: closeCompletion },
      { key: 'Ctrl-Space', run: startCompletion },
    ]))
    const view = new EditorView({ parent, state: EditorState.create({
      doc: propsRef.current.value,
      extensions: [
        sql({ dialect: propsRef.current.dialect === 'sqlite' ? SQLite : MySQL, upperCaseKeywords: true }),
        syntaxHighlighting(sqlHighlight),
        lineNumbers(), drawSelection(), highlightActiveLine(), bracketMatching(), closeBrackets(), history(),
        shortcuts, keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap]),
        completionCompartment.of(autocompletion({ override: [propsRef.current.completionSource], activateOnTyping: true, activateOnTypingDelay: 180, maxRenderedOptions: 80 })),
        tooltips({ position: 'fixed' }), sqlEditorTheme, sqlDiagnostics,
        placeholder('例如：SELECT id, name FROM users ORDER BY id DESC'),
        EditorView.contentAttributes.of({ id: propsRef.current.id, 'aria-label': 'SQL 编辑器', spellcheck: 'false', 'aria-multiline': 'true', 'aria-describedby': propsRef.current.diagnosticsId }),
        EditorView.domEventHandlers({
          compositionstart: (_event, view) => { view.dom.classList.add('cm-sql-composing'); propsRef.current.onCompositionChange(true) },
          compositionend: (_event, view) => { view.dom.classList.remove('cm-sql-composing'); propsRef.current.onCompositionChange(false) },
          blur: (_event, view) => { view.dom.classList.remove('cm-sql-composing'); propsRef.current.onCompositionChange(false) },
        }),
        EditorView.updateListener.of((update) => { if (update.docChanged && !applyingExternal.current) propsRef.current.onChange(update.state.doc.toString()) }),
      ],
    }) })
    viewRef.current = view
    return () => { viewRef.current = null; view.destroy() }
  }, [completionCompartment])

  React.useEffect(() => {
    const view = viewRef.current
    if (!view) return
    /** 切库先关闭旧菜单，异步 source 也会校验 contextKey。 */
    if (contextRef.current !== props.contextKey) { closeCompletion(view); contextRef.current = props.contextKey }
    if (view.state.doc.toString() === props.value) return
    applyingExternal.current = true
    try {
      closeCompletion(view)
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: props.value }, selection: { anchor: props.value.length }, annotations: Transaction.addToHistory.of(false) })
    } finally { applyingExternal.current = false }
  }, [props.value, props.contextKey])

  React.useEffect(() => {
    viewRef.current?.dispatch({ effects: completionCompartment.reconfigure(autocompletion({ override: [props.completionSource], activateOnTyping: true, activateOnTypingDelay: 180, maxRenderedOptions: 80 })) })
  }, [completionCompartment, props.completionSource])

  React.useEffect(() => {
    /** 末尾缺少 token 的诊断用最后一个字符显示标记；定位仍使用原始区间。 */
    const view = viewRef.current
    if (!view) return
    const length = view.state.doc.length
    const diagnostics = props.diagnostics.map((diagnostic) => {
      const to = Math.max(0, Math.min(length, diagnostic.to))
      const from = Math.max(0, Math.min(diagnostic.from, to > 0 ? to - 1 : 0))
      return { ...diagnostic, from, to }
    })
    view.dispatch({ effects: setSqlDiagnostics.of(diagnostics) })
  }, [props.diagnostics, props.contextKey])

  return <div ref={hostRef} className="h-36 min-h-28 max-h-80 resize-y overflow-hidden focus-within:bg-muted/5 dark:[--sql-keyword:#d2a8ff] dark:[--sql-string:#a5d6ff] dark:[--sql-number:#79c0ff]" data-server-ops-codemirror data-server-ops-sql-dialect={props.dialect} />
})
