import {
  Bot,
  Check,
  ChevronRight,
  FileText,
  FolderSearch,
  Globe2,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from 'lucide-react'
import type { ToolUseContent, ToolResultContent, TextBlock } from '../../atoms'

const TOOL_NAMES: Record<string, string> = {
  Read: '读取文件', Edit: '编辑文件', Write: '写入文件', Bash: '执行命令',
  Grep: '搜索内容', Glob: '搜索文件', WebSearch: '网络搜索', WebFetch: '获取网页',
  Agent: '调用子代理', TaskCreate: '创建任务', TaskUpdate: '更新任务',
  TaskGet: '获取任务', TaskList: '列出任务', NotebookEdit: '编辑笔记本',
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Read: FileText,
  Edit: Pencil,
  Write: FileText,
  Bash: Terminal,
  Grep: Search,
  Glob: FolderSearch,
  WebSearch: Globe2,
  WebFetch: Globe2,
  Agent: Bot,
  TaskCreate: FileText,
  TaskUpdate: Check,
}

function getToolSummary(name: string, input: Record<string, unknown>): string {
  const displayName = TOOL_NAMES[name] || name.replace(/^mcp__/, '').replace(/__/g, ' → ')
  if (name === 'Read' || name === 'Edit' || name === 'Write') {
    const path = String(input.file_path ?? '').split('/').pop() || ''
    return `${displayName} ${path}`
  }
  if (name === 'Bash') {
    const cmd = String(input.command ?? '').slice(0, 60)
    return `${displayName}: ${cmd}`
  }
  if (name === 'Grep') return `${displayName}: ${input.pattern ?? ''}`
  if (name === 'Glob') return `${displayName}: ${input.pattern ?? ''}`
  if (name === 'WebSearch') return `${displayName}: ${input.query ?? ''}`
  return displayName
}

export function getToolResultText(block: ToolResultContent): string {
  const content = block.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((c): c is TextBlock => c.type === 'text')
      .map(c => c.text || '')
      .join('\n')
  }
  return ''
}

export function ToolUseBlock({ toolUse, result }: { toolUse: ToolUseContent; result?: ToolResultContent }) {
  const name = toolUse.name
  const input = toolUse.input ?? {}
  const summary = getToolSummary(name, input)
  const resultText = result ? getToolResultText(result) : ''
  const hasError = result?.is_error === true
  const resultPreview = resultText.slice(0, 500)
  /** 根据工具名选择稳定图标，未知工具使用通用工具标识。 */
  const ToolIcon = TOOL_ICONS[name] ?? Wrench

  return (
    <details className="group overflow-hidden rounded-md border border-border bg-muted/30">
      <summary className="flex min-h-9 cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-xs transition-colors hover:bg-muted/70 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
        <ToolIcon aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-foreground/80">{summary}</span>
        {result && (
          <span className={hasError ? 'text-destructive' : 'text-muted-foreground'}>
            {hasError
              ? <X aria-label="执行失败" className="h-3.5 w-3.5" />
              : <Check aria-label="执行完成" className="h-3.5 w-3.5" />}
          </span>
        )}
      </summary>
      {resultPreview && (
        <div className="px-3 py-2 border-t border-border/30">
          {hasError ? (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-destructive">{resultPreview}</pre>
          ) : (
            <pre className="whitespace-pre-wrap break-all font-mono text-[11px] text-muted-foreground">{resultPreview}</pre>
          )}
          {resultText.length > 500 && (
            <span className="text-[10px] text-muted-foreground/60">...共 {resultText.length} 字符</span>
          )}
        </div>
      )}
    </details>
  )
}
