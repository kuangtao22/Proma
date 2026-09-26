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
 *
 * 空态的边界：两条证据源都只覆盖「受管根 + 附加目录 + 项目根」与写类工具入参，
 * 命令行工具在工作区外写的文件既不在监听范围也不会留下写类工具入参，因此空态只能
 * 说明「受管范围内没看到改动」，不能断言本轮没有任何改动。
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

/** 命令行工具：它们的写入只体现在文件系统上，可能落在受监听范围之外。 */
const SHELL_TOOL_NAMES = new Set(['Bash', 'Shell'])

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
 * 判断本轮是否调用过命令行工具。
 *
 * 命令行可以在监听范围之外写文件，且不会产生写类工具入参（例如 `python3 - <<PY ...` 直接改写
 * 外部仓库的源码），所以这种轮次的空态必须带上范围限定，避免把「没看到」说成「没有改动」。
 *
 * @param turnMessages 本轮全部 SDK 消息。
 * @returns 出现过命令行工具调用时为 true。
 */
export function hasShellToolCall(turnMessages: SDKMessage[]): boolean {
  for (const msg of turnMessages) {
    if (msg.type !== 'assistant') continue
    const blocks = (msg as SDKAssistantMessage).message?.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue
      if (SHELL_TOOL_NAMES.has((block as SDKToolUseBlock).name)) return true
    }
  }
  return false
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
  /** 本轮是否存在「看到改动但无法归属到本会话」的共享根事件。 */
  runUnattributed?: boolean
  /** 是否按大小写不敏感比较路径（Windows 为 true）。 */
  caseInsensitivePaths?: boolean
}

export function TurnFileChangesSummary({
  turnMessages,
  basePath,
  runPaths,
  runObserved,
  runUnattributed,
  caseInsensitivePaths,
}: TurnFileChangesSummaryProps): React.ReactElement | null {
  const paths = React.useMemo(() => mergeTurnFilePaths(
    collectFilePaths(turnMessages),
    runPaths ?? [],
    caseInsensitivePaths === true,
  ), [turnMessages, runPaths, caseInsensitivePaths])

  // 业务代码与构建产物混在一条横排里很难扫读，这里按分类分行展示。
  const groups = React.useMemo(() => groupAgentFileChangesByCategory(paths), [paths])

  // 命令行轮次的空态需要额外说明范围：受监听目录之外的写入不会出现在这里。
  const shellToolUsed = React.useMemo(() => hasShellToolCall(turnMessages), [turnMessages])

  // 无路径且无法确认本轮已被完整跟踪时保持静默：历史上早于本次运行的 turn 无从判断，
  // 强行显示「无改动」会把遗漏写成结论。
  if (paths.length === 0 && runObserved !== true) return null

  return (
    <div className="pl-[46px] mt-3">
      <div className="pt-3 border-t-2 border-dashed border-border/60">
        <div className="flex flex-wrap items-center gap-1.5">
          {paths.length === 0 ? (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs text-muted-foreground">
                {runUnattributed === true
                  ? '本轮检测到共享目录有改动，但无法归属到本会话'
                  : '本轮未检测到受管范围内的文件改动'}
              </span>
              {/* 共享目录无法归属已经解释了「没看到」的原因，不再叠加命令行范围说明。 */}
              {runUnattributed !== true && shellToolUsed && (
                <span className="text-xs text-muted-foreground/70">
                  本轮有命令行工具调用，工作区外的写入不计入这里
                </span>
              )}
            </div>
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
