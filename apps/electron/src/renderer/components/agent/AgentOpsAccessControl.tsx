import * as React from 'react'
import { useAtomValue, useSetAtom } from 'jotai'
import { LoaderCircle, ShieldCheck } from 'lucide-react'
import type { AgentSessionMeta, AgentToolMode } from '@proma/shared'
import { agentSessionsAtom } from '@/atoms/agent-atoms'
import { Button } from '@/components/ui/button'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { toast } from 'sonner'

/** 每次发送都从当前持久化会话快照解析模式，旧回调不会带回旧值。 */
export function resolveAgentSendToolMode(sessions: readonly AgentSessionMeta[], sessionId: string): AgentToolMode {
  return sessions.find((session) => session.id === sessionId)?.toolMode ?? 'standard'
}

/** 主进程负责停止在途 run 并保存模式，成功后才向本地会话列表发布。 */
export async function persistAgentToolMode(
  sessionId: string,
  mode: AgentToolMode,
  update: (sessionId: string, mode: AgentToolMode) => Promise<AgentSessionMeta>,
  publish: (session: AgentSessionMeta) => void,
): Promise<void> {
  const session = await update(sessionId, mode)
  publish(session)
}

/** 仅在运维授权弹窗内提供会话工具模式设置，聊天输入区不展示运维控件。 */
export function AgentOpsAccessControl({ sessionId }: { sessionId: string }): React.ReactElement {
  /** 只订阅会话元数据，不订阅输入草稿或消息历史。 */
  const sessions = useAtomValue(agentSessionsAtom)
  const setSessions = useSetAtom(agentSessionsAtom)
  const session = sessions.find((item) => item.id === sessionId)
  const mode = session?.toolMode ?? 'standard'
  const [switching, setSwitching] = React.useState(false)
  /** 模式更新完成后才替换 Jotai 中对应的会话元数据。 */
  const changeMode = async (next: AgentToolMode): Promise<void> => {
    if (!session || switching || next === mode) return
    setSwitching(true)
    try {
      await persistAgentToolMode(sessionId, next, window.electronAPI.updateAgentSessionToolMode, (updated) => {
        setSessions((previous) => previous.map((item) => item.id === sessionId ? updated : item))
      })
    } catch (error) {
      toast.error('切换运维模式失败', { description: error instanceof Error ? error.message : '请稍后重试' })
    } finally {
      setSwitching(false)
    }
  }

  return <div className="flex items-center gap-1" data-agent-ops-access-control>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="h-8 gap-1.5 px-2 text-xs" disabled={!session || switching} aria-label="选择 Agent 工具模式">
          {switching ? <LoaderCircle className="size-3.5 animate-spin" /> : <ShieldCheck className="size-3.5" />}
          {mode === 'server-ops-read' ? '运维只读' : '标准'}
        </Button>
      </DropdownMenuTrigger>
      {/* 菜单通过 Portal 渲染，需要高于运维授权弹窗的 260 层。 */}
      <DropdownMenuContent align="start" className="z-[270]">
        <DropdownMenuItem onSelect={() => { void changeMode('standard') }}>标准模式</DropdownMenuItem>
        <DropdownMenuItem onSelect={() => { void changeMode('server-ops-read') }}>运维只读</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>
}
