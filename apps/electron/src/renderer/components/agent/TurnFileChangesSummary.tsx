/**
 * TurnFileChangesSummary — Turn 底部文件改动汇总
 *
 * 在 AssistantTurnRenderer 的 MessageActions 之上，以 chip 横排展示本轮真实改动过的文件。
 * 路径由两部分合并而来：
 * 1. 修改类工具调用（Edit / Write / MultiEdit / NotebookEdit）成功返回后的入参路径；
 * 2. 主进程文件监听器归属到本轮运行的真实落盘路径 —— 覆盖 Bash、脚本、格式化器、
 *    构建工具等非写类工具产生的改动。
 *
 * 子代理（Agent/Task）的修改也会冒泡到此处——因为 SDK 的子代理 assistant
 * 消息同样存在于 turn.turnMessages 中（通过 parent_tool_use_id 关联）。
 *
 * 文件 chip 直接复用 FilePathChip（与 Agent 消息中的渲染完全一致）。
 */

import * as React from 'react'
import type {
  SDKMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKToolUseBlock,
  SDKToolResultBlock,
} from '@proma/shared'
import { FilePathChip } from '@/components/ai-elements/file-path-chip'
import { groupAgentFileChangesByCategory, mergeTurnFilePaths } from '@/lib/agent-run-file-changes'

const MUTATING_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/**
 * 本轮"触碰过"的工具集合（改 + 读）——用于正文内联文件引用的路径补全，比 MUTATING_TOOLS 更宽。
 * Read 的 input.file_path 与 Edit/Write 同构，都是绝对路径，可零解析纳入映射。
 * Grep/Glob 的 input 只有 pattern、命中文件仅存在于 tool_result 中，暂不纳入。
 * 注意：底部"文件改动汇总"chip 仍只用 MUTATING_TOOLS，不受此集合影响。
 */
const TOUCHED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'Read'])

function getFilePath(toolName: string, input: Record<string, unknown>): string | null {
  if (toolName === 'NotebookEdit') {
    const fp = input.notebook_path
    return typeof fp === 'string' ? fp : null
  }
  const fp = input.file_path ?? input.filePath ?? input.path
  return typeof fp === 'string' ? fp : null
}

/**
 * 收集本轮可展示的文件改动路径。
 *
 * 入参 `turnMessages`：本轮全部 SDK 消息；`tools`：视为改动来源的工具集合。
 * 返回值：按出现顺序去重的文件路径。只有已返回且未报错的工具调用才算证据，
 * 流式过程中尚未返回的 tool_use 不能提前渲染为可点击 Chip。
 */
export function collectFilePaths(turnMessages: SDKMessage[], tools: Set<string> = MUTATING_TOOLS): string[] {
  const succeeded = new Set<string>()
  for (const msg of turnMessages) {
    if (msg.type !== 'user') continue
    const blocks = (msg as SDKUserMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue
      const rb = block as SDKToolResultBlock
      if (rb.is_error !== true) succeeded.add(rb.tool_use_id)
    }
  }

  const seen = new Set<string>()
  const paths: string[] = []
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      const tu = block as SDKToolUseBlock
      if (!tools.has(tu.name)) continue
      if (!succeeded.has(tu.id)) continue

      const filePath = getFilePath(tu.name, tu.input as Record<string, unknown>)
      if (!filePath || seen.has(filePath)) continue
      seen.add(filePath)
      paths.push(filePath)
    }
  }
  return paths
}

/**
 * 构建「文件名 → 绝对路径」映射，供消息正文内联文件引用补全裸文件名使用。
 * 数据源为本轮"触碰过"的文件（TOUCHED_TOOLS：改过 + Read 读过），比底部改动汇总更宽，
 * 覆盖"本轮只读过没改就在正文引用"的高频场景；拿到的都是绝对路径。
 * 同名不同目录的文件无法凭裸文件名区分，直接从映射中剔除，交由既有 basePaths 解析逻辑处理
 * （不比补全前更差）。
 */
export function buildTurnFileNameMap(
  turnMessages: SDKMessage[],
  extraPaths: readonly string[] = [],
): Map<string, string> {
  // 真实落盘路径同样参与补全：脚本/格式化器生成的文件也应能从裸文件名解析到绝对路径。
  const paths = mergeTurnFilePaths(collectFilePaths(turnMessages, TOUCHED_TOOLS), extraPaths)
  const map = new Map<string, string>()
  const conflicted = new Set<string>()
  for (const p of paths) {
    const name = p.split(/[\\/]/).pop() || p
    if (conflicted.has(name)) continue
    const existing = map.get(name)
    if (existing && existing !== p) {
      map.delete(name)
      conflicted.add(name)
      continue
    }
    map.set(name, p)
  }
  return map
}

export interface TurnFileChangesSummaryProps {
  turnMessages: SDKMessage[]
  basePath?: string
  /** 文件监听器归属到本轮运行的真实落盘路径，用于补齐非工具写入。 */
  runPaths?: readonly string[]
  /** 是否从本轮开始前就已在跟踪；仅 true 时才允许断言「本轮无文件改动」。 */
  runObserved?: boolean
  /** 是否按大小写不敏感比较路径（Windows 为 true）。 */
  caseInsensitivePaths?: boolean
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
  runPaths,
  runObserved,
  caseInsensitivePaths,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => mergeTurnFilePaths(
    collectFilePaths(turnMessages),
    runPaths ?? [],
    caseInsensitivePaths === true,
  ), [turnMessages, runPaths, caseInsensitivePaths])

  // 业务代码与构建产物混在一条横排里很难扫读，这里按分类分行展示。
  const groups = React.useMemo(() => groupAgentFileChangesByCategory(paths), [paths])

  // 无路径且无法确认本轮已被完整跟踪时保持静默：历史上早于本次运行的 turn 无从判断，
  // 强行显示「无改动」会把遗漏写成结论。
  if (paths.length === 0 && runObserved !== true) return null

  return (
    <div className="pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap items-center gap-1.5">
          {paths.length === 0 ? (
            <span className="text-xs text-muted-foreground">本轮未检测到文件改动</span>
          ) : (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">
                本轮文件改动 {paths.length}
              </span>
              {groups.map((group) => (
                <div key={group.category} className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-xs text-muted-foreground/70">
                    {group.label} {group.paths.length}
                  </span>
                  {group.paths.map((filePath) => (
                    <FilePathChip
                      key={filePath}
                      filePath={filePath}
                      basePath={basePath}
                      openMode="diff-preferred"
                    />
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
