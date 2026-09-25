/**
 * PermissionBanner — Agent 权限请求横幅
 *
 * 内联在 Agent 对话流底部，当有待处理的权限请求时显示。
 * 显示工具名、命令内容、危险等级，提供允许/拒绝/总是允许操作。
 * 支持队列模式：多个并发请求按 FIFO 逐个展示。
 *
 * 设计参考 Craft Agents OSS 的内联权限 UI。
 */

import * as React from 'react'
import { useAtom } from 'jotai'
import { Shield, ShieldAlert, Check, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { allPendingPermissionRequestsAtom } from '@/atoms/agent-atoms'
import type { DangerLevel } from '@proma/shared'
import { describeApiWorkbenchApproval, formatApiApprovalCaseDiff } from './api-approval-view'

/** 危险等级对应的图标颜色 */
const DANGER_ICON_STYLES: Record<DangerLevel, string> = {
  safe: 'text-green-500',
  normal: 'text-primary',
  dangerous: 'text-amber-500',
}

/** 解析工具显示名称（MCP 工具显示 server / tool） */
function formatToolName(toolName: string): string {
  const parts = toolName.split('__')
  if (parts[0] === 'mcp' && parts.length >= 3) {
    return `${parts[1]} / ${parts.slice(2).join('__')}`
  }
  return toolName
}

/** PermissionBanner 属性接口 */
interface PermissionBannerProps {
  sessionId: string
  /** 交由 AgentView 统一执行权威停止与状态恢复。 */
  onStop: () => void
}

export function PermissionBanner({ sessionId, onStop }: PermissionBannerProps): React.ReactElement | null {
  const [allRequests, setAllRequests] = useAtom(allPendingPermissionRequestsAtom)
  const requests = allRequests.get(sessionId) ?? []
  const [responding, setResponding] = React.useState(false)
  const respondRef = React.useRef<(behavior: 'allow' | 'deny', alwaysAllow?: boolean) => void>()

  const request = requests[0] ?? null

  // Enter 键快捷允许
  React.useEffect(() => {
    if (!request) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        (e.target instanceof HTMLElement && e.target.isContentEditable)
      ) return
      if (e.key === 'Enter') {
        e.preventDefault()
        respondRef.current?.('allow')
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [request?.requestId])

  if (!request) return null

  const iconColor = DANGER_ICON_STYLES[request.dangerLevel]
  const isDangerous = request.dangerLevel === 'dangerous'
  const IconComponent = isDangerous ? ShieldAlert : Shield

  /** 响应权限请求 */
  const respond = async (behavior: 'allow' | 'deny', alwaysAllow = false): Promise<void> => {
    if (responding) return
    setResponding(true)

    try {
      await window.electronAPI.respondPermission({
        requestId: request.requestId,
        behavior,
        alwaysAllow,
      })
      // 移除已响应的请求（FIFO 出队）
      setAllRequests((prev) => {
        const map = new Map(prev)
        const current = map.get(sessionId) ?? []
        const newValue = current.filter((r) => r.requestId !== request.requestId)
        if (newValue.length === 0) map.delete(sessionId)
        else map.set(sessionId, newValue)
        return map
      })
    } catch (error) {
      console.error('[PermissionBanner] 响应失败:', error)
    } finally {
      setResponding(false)
    }
  }

  respondRef.current = respond

  /** 接口工作台的发送/保存单独渲染：用户必须看清目标与用例改动，而不是一坨 JSON。 */
  const apiApproval = describeApiWorkbenchApproval(request.toolName, request.toolInput)

  return (
    <div
      className="mx-4 mb-3 rounded-xl bg-card shadow-lg overflow-hidden animate-in slide-in-from-bottom-2 duration-200"
    >
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2">
          <IconComponent className={`size-4 ${iconColor}`} />
          <span className="text-sm font-medium">
            {isDangerous ? '危险操作需要确认' : '需要确认'}
          </span>
          {requests.length > 1 && (
            <span className="text-xs text-muted-foreground">
              (+{requests.length - 1})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground font-mono">
            {request.sdkDisplayName ?? formatToolName(request.toolName)}
          </span>
          <button
            type="button"
            className="size-5 flex items-center justify-center rounded-md text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
            onClick={onStop}
            title="关闭并终止 Agent"
          >
            <X className="size-3.5" />
          </button>
        </div>
      </div>

      {/* 命令/操作内容 */}
      <div className="px-3 pb-2 space-y-1.5">
        {apiApproval ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-foreground">{apiApproval.title}</p>
            {apiApproval.lines.map((line) => (
              <p key={line} className="text-xs text-muted-foreground font-mono break-all">{line}</p>
            ))}
            {apiApproval.files.length > 0 && (
              <div className="rounded bg-background/50 px-2 py-1.5 space-y-1">
                <p className="text-[11px] text-muted-foreground">本次将读取并上传的文件（批准后才读取字节）</p>
                {apiApproval.files.map((file) => (
                  <p key={`${file.field}:${file.path}`} className="text-xs font-mono break-all">{file.text}</p>
                ))}
                <p className="text-[10px] text-muted-foreground">路径已按真实路径（realpath）展示，符号链接不能伪装成别的文件名；目录与设备等特殊文件不会出现在这里。</p>
              </div>
            )}
            {apiApproval.steps.length > 0 && (
              <div className="rounded bg-background/50 px-2 py-1.5 space-y-1">
                <p className="text-[11px] text-muted-foreground">本次将按顺序执行的步骤</p>
                {apiApproval.steps.map((step) => (
                  <p key={`${step.index}:${step.text}`} className="text-xs font-mono break-all">{step.text}</p>
                ))}
                <p className="text-[10px] text-muted-foreground">批准一次即授权这条流程的全部步骤；执行时每一步仍会与这份清单核对，不一致就整条流程拒绝。</p>
              </div>
            )}
            {apiApproval.warnings.length > 0 && (
              <div className="rounded bg-background/50 px-2 py-1.5 space-y-1">
                {apiApproval.warnings.map((warning) => (
                  <p key={warning} className="text-[11px] text-amber-600">{warning}</p>
                ))}
              </div>
            )}
            {apiApproval.caseDiff.length > 0 && (
              <div className="rounded bg-background/50 px-2 py-1.5 space-y-1">
                <p className="text-[11px] text-muted-foreground">用例改动</p>
                {apiApproval.caseDiff.map((entry) => (
                  <p key={entry.caseId} className={entry.change === 'removed' ? 'text-xs text-destructive' : 'text-xs'}>
                    {formatApiApprovalCaseDiff(entry)}
                  </p>
                ))}
                <p className="text-[10px] text-muted-foreground">Agent 新增或修改的用例会在报告里标注来源；人工创建的用例不可被 Agent 修改或删除。</p>
              </div>
            )}
          </div>
        ) : null}
        {/* SDK 可读标题（优先展示，描述操作意图） */}
        {request.sdkTitle && (
          <p className="text-xs text-foreground">{request.sdkTitle}</p>
        )}
        {/* SDK 详细描述（与标题不同时才展示） */}
        {request.sdkDescription && request.sdkDescription !== request.sdkTitle && (
          <p className="text-xs text-muted-foreground">{request.sdkDescription}</p>
        )}
        {/* Bash 命令：始终展示代码块 */}
        {request.command ? (
          <pre className="text-xs font-mono bg-background/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
            {request.command}
          </pre>
        ) : !apiApproval && !request.sdkTitle && Object.keys(request.toolInput).length > 0 ? (
          <pre className="text-xs font-mono bg-background/50 rounded px-2 py-1.5 overflow-x-auto whitespace-pre-wrap break-all max-h-[120px] overflow-y-auto">
            {JSON.stringify(request.toolInput, null, 2)}
          </pre>
        ) : !request.sdkTitle ? (
          <p className="text-xs text-muted-foreground">
            {request.description}
          </p>
        ) : null}
      </div>

      {/* 操作按钮 */}
      <div className="flex items-center justify-end gap-1.5 px-3 pb-2.5">
        <span className="text-[10px] text-muted-foreground/40 mr-auto">
          Enter 允许
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => respond('deny')}
          disabled={responding}
          className="h-7 px-3 text-xs text-muted-foreground hover:text-destructive"
        >
          <X className="size-3 mr-1" />
          拒绝
        </Button>

        {request.allowAlways !== false && <Button
          variant="outline"
          size="sm"
          onClick={() => respond('allow', true)}
          disabled={responding}
          className="h-7 px-3 text-xs"
        >
          本次会话总是允许
        </Button>}

        <Button
          variant="default"
          size="sm"
          onClick={() => respond('allow')}
          disabled={responding}
          className="h-7 px-3 text-xs"
        >
          <Check className="size-3 mr-1" />
          允许
        </Button>
      </div>
    </div>
  )
}
