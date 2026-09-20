import { syntaxTree } from '@codemirror/language'
import type { EditorState, Extension, Text } from '@codemirror/state'
import { Decoration, EditorView, MatchDecorator, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from '@codemirror/view'
import { getLeadingFrontmatterRange } from '../markdown/live-markdown-frontmatter'

export interface VaultWikiLink {
  /** 用于解析 Vault 笔记路径的原始目标。 */
  target: string
  /** 正文中展示给用户的文本，缺少别名时等于目标。 */
  label: string
}

export interface OpenVaultWikiLinkOptions {
  /** 用户点击的原始双链目标。 */
  target: string
  /** 当前笔记路径，用于解析相对目标。 */
  source: string
  /** 当前文件树中的全部笔记路径。 */
  files: readonly string[]
  /** 复用 Vault 现有保存与读取链路打开已解析路径。 */
  onOpen: (relativePath: string) => Promise<void>
  /** 目标缺失或存在歧义时显示用户提示。 */
  onMissing: (target: string) => void
}

// Text 不可变；选区和焦点事务复用文档，弱引用不会保留历史正文。
const frontmatterEnds = new WeakMap<Text, number>()

/** 返回已闭合 YAML Properties 的正文起点，供双链显示边界复用。 */
function getFrontmatterEnd(doc: Text): number {
  /** 同一不可变文档已计算过的 Properties 结束位置。 */
  const cachedEnd = frontmatterEnds.get(doc)
  if (cachedEnd !== undefined) return cachedEnd
  /** 当前文档已闭合的开头 YAML Properties 范围。 */
  const range = doc.line(1).text.replace(/^\uFEFF/, '') === '---'
    ? getLeadingFrontmatterRange(doc.toJSON())
    : null
  /** 双链可开始渲染的最小文档位置。 */
  const end = range ? doc.line(range.endLine).to : 0
  frontmatterEnds.set(doc, end)
  return end
}

/** 解析完整双链源码，别名只改变显示文本，不改变跳转目标。 */
export function parseVaultWikiLink(source: string): VaultWikiLink | null {
  /** 完整双链语法中的目标与可选别名捕获结果。 */
  const match = /^\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]$/.exec(source)
  /** 去除用户输入两端空白后的实际跳转目标。 */
  const target = match?.[1]?.trim()
  if (!target) return null
  return { target, label: match?.[2]?.trim() || target }
}

/** 归一化 Vault 内相对路径，越出根目录时返回 null。 */
function normalizeVaultPath(path: string): string | null {
  /** 逐段归一化后的 Vault 内安全路径。 */
  const parts: string[] = []
  // 每个路径段只允许留在 Vault 根目录内，父级段会弹出上一层。
  for (const part of path.split('/')) {
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else if (part && part !== '.') {
      parts.push(part)
    }
  }
  return parts.join('/')
}

/** 移除 Markdown 扩展名，便于同时匹配 Obsidian 的带扩展名和无扩展名写法。 */
function getVaultNoteStem(file: string): string {
  return file.replace(/\.md$/i, '')
}

/** 根路径精确命中优先，其次当前目录，最后唯一后缀；仅解析 Vault 内部笔记。 */
export function resolveVaultWikiLink(target: string, source: string, files: readonly string[]): string | null {
  /** 去除空白和 Markdown 扩展名后的 Obsidian 笔记目标。 */
  const note = target.trim().replace(/\.md$/i, '')
  if (!note || /[#^:]/.test(note)) return null

  /** 当前笔记所在目录，供无根路径和显式相对路径解析。 */
  const sourceFolder = source.slice(0, source.lastIndexOf('/') + 1)
  /** 以当前笔记目录为基准归一化的候选路径。 */
  const relativePath = normalizeVaultPath(sourceFolder + note)
  /** 以 Vault 根目录为基准归一化的候选路径。 */
  const rootPath = normalizeVaultPath(note)
  if (note.startsWith('./') || note.startsWith('../')) {
    return relativePath === null
      ? null
      : files.find((file) => getVaultNoteStem(file) === relativePath) ?? null
  }

  /** 与 Vault 根路径完全一致的笔记。 */
  const exactFile = files.find((file) => getVaultNoteStem(file) === rootPath)
  if (exactFile) return exactFile
  /** 与当前笔记目录完全一致的笔记。 */
  const localFile = files.find((file) => getVaultNoteStem(file) === relativePath)
  if (localFile) return localFile
  /** 全 Vault 中以同一目标结尾的候选，用于判断名称是否唯一。 */
  const suffixMatches = files.filter((file) => getVaultNoteStem(file).endsWith(`/${note}`))
  return suffixMatches.length === 1 ? suffixMatches[0]! : null
}

/** 使用 Markdown 语法树排除代码、HTML 和已有链接；转义与嵌入保持原样。 */
export function canRenderVaultWikiLink(state: EditorState, from: number): boolean {
  /** 双链前方的本行文本，用于识别嵌入与反斜杠转义。 */
  const precedingText = state.sliceDoc(state.doc.lineAt(from).from, from)
  /** 双链前连续反斜杠数量，奇数表示当前双链被转义。 */
  const trailingEscapeCount = precedingText.match(/\\+$/)?.[0].length ?? 0
  if (precedingText.endsWith('!') || trailingEscapeCount % 2 === 1) return false
  // 沿语法树父链检查，避免把代码、HTML 和标准 Markdown 链接中的源码替换为按钮。
  for (let node = syntaxTree(state).resolveInner(from, 1); node; node = node.parent!) {
    if (/^(FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag|Link|Image)$/.test(node.name)) return false
  }
  // 与 Properties 复用封闭区间规则；未闭合的首行分隔线仍是普通 Markdown。
  return from >= getFrontmatterEnd(state.doc)
}

/** 判断打开失败是否源于外部删除或重命名，以便刷新陈旧文件树。 */
export function isVaultFileNotFoundError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('Vault 文件不存在:')
}

/** 解析目标并复用现有异步打开链路；返回值表示是否启动了导航。 */
export async function openVaultWikiLink(options: OpenVaultWikiLinkOptions): Promise<boolean> {
  /** 按当前来源和文件树解析出的唯一 Vault 笔记路径。 */
  const relativePath = resolveVaultWikiLink(options.target, options.source, options.files)
  if (!relativePath) {
    options.onMissing(options.target)
    return false
  }
  await options.onOpen(relativePath)
  return true
}

/** CodeMirror 替换式双链组件，普通点击导航，Alt/Option 点击回到源码编辑。 */
class VaultWikiLinkWidget extends WidgetType {
  constructor(
    /** 点击后交给 Vault 路径解析器的原始目标。 */
    readonly target: string,
    /** 按钮向用户展示的目标名称或别名。 */
    readonly label: string,
    /** 触发当前 Vault 导航的回调。 */
    readonly onOpen: (target: string) => void,
  ) {
    super()
  }

  /** 判断两个双链组件能否复用同一 DOM。 */
  override eq(other: VaultWikiLinkWidget): boolean {
    return this.target === other.target && this.label === other.label && this.onOpen === other.onOpen
  }

  /** 创建带导航和源码编辑入口的可访问按钮。 */
  override toDOM(view: EditorView): HTMLElement {
    /** 替换双链源码并承载导航、键盘焦点和可访问名称的按钮。 */
    const linkButton = document.createElement('button')
    linkButton.type = 'button'
    linkButton.className = 'vault-wikilink'
    linkButton.textContent = `[${this.label}]`
    linkButton.title = `${this.target}（Alt/Option 点击编辑链接）`
    linkButton.setAttribute('aria-label', `打开笔记：${this.label}`)
    // 在 CodeMirror 把指针位置变成源码选区前保留链接，普通单击即可打开。
    linkButton.onmousedown = (event) => event.preventDefault()
    linkButton.onclick = (event) => {
      event.preventDefault()
      if (event.altKey) {
        /** 双链目标在编辑器文档中的起始编辑位置。 */
        const sourcePosition = view.posAtDOM(linkButton)
        view.dispatch({ selection: { anchor: sourcePosition + 2 } })
        view.focus()
        return
      }
      this.onOpen(this.target)
    }
    return linkButton
  }

  /** 让 CodeMirror 忽略按钮内部事件，由组件自身处理点击。 */
  override ignoreEvent(): boolean {
    return true
  }
}

/** 创建 Vault 专属双链 Live Preview 扩展，不向共享 Markdown 编辑器泄露 Vault 语义。 */
export function createVaultWikiLinks(onOpen: (target: string) => void): Extension {
  /** 扫描可显示双链并生成替换装饰的 CodeMirror 匹配器。 */
  const matcher = new MatchDecorator({
    regexp: /\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g,
    decorate: (add, from, to, match, view) => {
      if (!canRenderVaultWikiLink(view.state, from)) return
      /** 当前编辑器选区是否与双链重叠；重叠时保留源码方便编辑。 */
      const overlapsSelection = view.hasFocus
        && view.state.selection.ranges.some((range) => range.from <= to && range.to >= from)
      if (overlapsSelection) return
      /** 从正则命中结果中取得独立的跳转目标和显示文本。 */
      const parsedLink = parseVaultWikiLink(match[0])
      if (!parsedLink) return
      add(from, to, Decoration.replace({
        widget: new VaultWikiLinkWidget(parsedLink.target, parsedLink.label, onOpen),
      }))
    },
  })

  return [
    ViewPlugin.fromClass(class {
      /** 当前编辑器视图中的双链替换装饰。 */
      decorations: DecorationSet

      /** 首次挂载时扫描当前文档并创建双链装饰。 */
      constructor(view: EditorView) {
        this.decorations = matcher.createDeco(view)
      }

      /** 文档、选区、焦点或语法树变化时更新双链装饰。 */
      update(update: ViewUpdate): void {
        /** Markdown 解析树是否随本次事务发生变化。 */
        const syntaxChanged = syntaxTree(update.startState) !== syntaxTree(update.state)
        this.decorations = update.docChanged || update.selectionSet || update.focusChanged || syntaxChanged
          ? matcher.createDeco(update.view)
          : matcher.updateDeco(update, this.decorations)
      }
    }, { decorations: (plugin) => plugin.decorations }),
    EditorView.baseTheme({
      '.vault-wikilink': {
        color: 'hsl(var(--primary))',
        cursor: 'pointer',
        font: 'inherit',
        padding: '0',
        border: '0',
        background: 'none',
        textDecoration: 'underline',
        textDecorationThickness: '1px',
        textUnderlineOffset: '2px',
      },
      '.vault-wikilink:hover': { textDecorationThickness: '2px' },
      '.vault-wikilink:focus-visible': { outline: '2px solid hsl(var(--ring))', outlineOffset: '2px' },
    }),
  ]
}
