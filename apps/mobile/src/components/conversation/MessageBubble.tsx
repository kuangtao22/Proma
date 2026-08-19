import { Bot, Brain, UserRound } from 'lucide-react'
import { ToolUseBlock } from './ToolUseBlock'
import { renderMd } from '../../utils/markdown'
import type { Message, ContentBlock, ToolUseContent, ToolResultContent } from '../../atoms'

function getContent(m: Message): ContentBlock[] | string | undefined {
  if (m.message?.content) return m.message.content
  return m.content
}

function asBlocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  if (Array.isArray(content)) return content
  return []
}

function extractText(m: Message): string {
  const content = getContent(m)
  if (Array.isArray(content)) {
    return content
      .filter((c): c is typeof c & { text: string } => c.type === 'text' && 'text' in c)
      .map(c => c.text)
      .join('\n')
  }
  if (typeof content === 'string') return content
  return ''
}

function extractThinking(m: Message): string {
  const content = getContent(m)
  if (Array.isArray(content)) {
    return content
      .filter((c): c is typeof c & { thinking: string } => c.type === 'thinking' && 'thinking' in c)
      .map(c => c.thinking)
      .join('\n')
  }
  return m.reasoning ?? ''
}

function extractToolUse(m: Message): ToolUseContent[] {
  return asBlocks(getContent(m)).filter((c): c is ToolUseContent => c.type === 'tool_use')
}

function hasToolResult(m: Message): boolean {
  return asBlocks(getContent(m)).some((c): c is ToolResultContent => c.type === 'tool_result')
}

/** 渲染移动端统一的 Proma 助手标识。 */
function AssistantAvatar() {
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
      <Bot aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
    </div>
  )
}

/** 渲染可折叠的思考内容，保持正文视觉层级安静。 */
function ReasoningBlock({ reasoning }: { reasoning: string }) {
  return (
    <details className="group overflow-hidden rounded-md border border-border bg-muted/40">
      <summary className="flex min-h-9 cursor-pointer select-none items-center gap-2 px-2.5 py-1.5 text-xs text-muted-foreground [&::-webkit-details-marker]:hidden">
        <Brain aria-hidden="true" className="h-3.5 w-3.5" />
        <span>思考过程</span>
      </summary>
      <div
        className="border-t border-border px-3 py-2 text-xs leading-5 text-muted-foreground break-words [overflow-wrap:anywhere]"
        dangerouslySetInnerHTML={{ __html: renderMd(reasoning) }}
      />
    </details>
  )
}

export function MessageBubble({ message: m, resultMap }: { message: Message; resultMap: Map<string, ToolResultContent> }) {
  const isUser = m.type === 'user' || m.role === 'user'
  const text = extractText(m)
  const reasoning = !isUser ? extractThinking(m) : ''

  if (isUser && hasToolResult(m) && !text) return null

  const toolUses = !isUser ? extractToolUse(m) : []

  if (!isUser && !text && !reasoning && toolUses.length > 0) {
    return (
      <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 space-y-1.5">
          {toolUses.map(tu => (
            <ToolUseBlock key={tu.id} toolUse={tu} result={resultMap.get(tu.id)} />
          ))}
        </div>
      </article>
    )
  }

  if (!isUser && !text && toolUses.length === 0 && reasoning) {
    return (
      <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
        <AssistantAvatar />
        <div className="min-w-0 flex-1">
          <ReasoningBlock reasoning={reasoning} />
        </div>
      </article>
    )
  }

  if (!text && !reasoning && toolUses.length === 0) return null

  if (!isUser) {
    return (
      <article data-message-role="assistant" className="flex min-w-0 gap-2.5">
        <AssistantAvatar />
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-medium text-foreground/70">{m.model || 'Proma'}</span>
            {m.createdAt && <span className="text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
          {toolUses.map(tu => (
            <ToolUseBlock key={tu.id} toolUse={tu} result={resultMap.get(tu.id)} />
          ))}
          {reasoning && <ReasoningBlock reasoning={reasoning} />}
          {text && (
            <div
              className="prose prose-sm max-w-none break-words text-sm leading-6 text-foreground [overflow-wrap:anywhere]"
              dangerouslySetInnerHTML={{ __html: renderMd(text) }}
            />
          )}
        </div>
      </article>
    )
  }

  return (
    <article data-message-role="user" className="flex min-w-0 flex-row-reverse gap-2.5">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border bg-card text-card-foreground">
        <UserRound aria-hidden="true" className="h-3.5 w-3.5 text-muted-foreground" />
      </div>
      <div className="flex min-w-0 flex-col items-end" style={{ maxWidth: 'calc(100% - 38px)' }}>
        {!hasToolResult(m) && (
          <div className="mb-1 flex items-center gap-2">
            <span className="text-[11px] font-medium text-foreground/70">我</span>
            {m.createdAt && <span className="text-[10px] text-muted-foreground">{new Date(m.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </div>
        )}
        <div className="min-w-0 rounded-md bg-secondary px-3 py-2 text-sm leading-6 text-secondary-foreground">
          <div
            className="prose prose-sm max-w-none break-words [overflow-wrap:anywhere]"
            dangerouslySetInnerHTML={{ __html: renderMd(text) }}
          />
        </div>
      </div>
    </article>
  )
}

export function MessageList({ messages }: { messages: Message[] }) {
  const resultMap = new Map<string, ToolResultContent>()
  for (const m of messages) {
    const blocks = asBlocks(getContent(m))
    for (const block of blocks) {
      if (block.type === 'tool_result') {
        resultMap.set(block.tool_use_id, block as ToolResultContent)
      }
    }
  }

  return (
    <>
      {messages.map((m, i) => (
        <MessageBubble key={m.id || i} message={m} resultMap={resultMap} />
      ))}
    </>
  )
}
