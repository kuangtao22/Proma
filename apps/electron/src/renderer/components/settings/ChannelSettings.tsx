/**
 * ChannelSettings - 渠道配置页
 *
 * 管理所有渠道的添加、编辑、删除与启用状态。
 */

import * as React from 'react'
import { useAtom, useSetAtom } from 'jotai'
import { AlertTriangle, ExternalLink, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { PROVIDER_LABELS } from '@proma/shared'
import type { Channel } from '@proma/shared'
import { getChannelLogo, PromaLogo } from '@/lib/model-logo'
import { agentChannelIdAtom, agentModelIdAtom } from '@/atoms/agent-atoms'
import { channelsAtom } from '@/atoms/chat-atoms'
import { SettingsSection, SettingsCard, SettingsRow } from './primitives'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { ChannelForm } from './ChannelForm'

/** 组件视图模式 */
type ViewMode = 'list' | 'create' | 'edit'

/** 渠道设置页最近一次成功数据与当前加载错误。 */
interface ChannelSettingsLoadState {
  /** 最近一次成功加载的渠道，失败时必须保留。 */
  channels: Channel[]
  /** 当前加载错误；成功后清空。 */
  error: string | null
}

/** 渠道设置页加载结果动作。 */
type ChannelSettingsLoadAction =
  | { type: 'load-succeeded'; channels: Channel[] }
  | { type: 'load-failed'; message: string }

/**
 * 合并渠道加载结果，确保瞬时读取失败不会把已显示的存量渠道替换为空列表。
 */
export function reduceChannelSettingsLoadState(
  state: ChannelSettingsLoadState,
  action: ChannelSettingsLoadAction,
): ChannelSettingsLoadState {
  if (action.type === 'load-succeeded') {
    return { channels: action.channels, error: null }
  }
  return { ...state, error: action.message }
}

/** 返回设置页可展示的渠道加载错误文本。 */
function formatChannelLoadError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function ChannelSettings(): React.ReactElement {
  const [loadState, setLoadState] = React.useState<ChannelSettingsLoadState>({ channels: [], error: null })
  const { channels, error: loadError } = loadState
  const [viewMode, setViewMode] = React.useState<ViewMode>('list')
  const [editingChannel, setEditingChannel] = React.useState<Channel | null>(null)
  const [loading, setLoading] = React.useState(true)
  const [agentChannelId, setAgentChannelId] = useAtom(agentChannelIdAtom)
  const [, setAgentModelId] = useAtom(agentModelIdAtom)
  const setGlobalChannels = useSetAtom(channelsAtom)
  const [deleteTarget, setDeleteTarget] = React.useState<Channel | null>(null)
  const agentChannelIdRef = React.useRef(agentChannelId)

  React.useEffect(() => {
    agentChannelIdRef.current = agentChannelId
  }, [agentChannelId])

  /** 加载渠道列表 */
  const loadChannels = React.useCallback(async (): Promise<void> => {
    try {
      const list = await window.electronAPI.listChannels()
      setLoadState((state) => reduceChannelSettingsLoadState(state, { type: 'load-succeeded', channels: list }))
      setGlobalChannels(list) // 同步到全局缓存
    } catch (error) {
      console.error('[渠道设置] 加载渠道列表失败:', error)
      setLoadState((state) => reduceChannelSettingsLoadState(state, {
        type: 'load-failed',
        message: formatChannelLoadError(error),
      }))
    } finally {
      setLoading(false)
    }
  }, [])

  React.useEffect(() => {
    void loadChannels()
  }, [loadChannels])

  /** 重新加载渠道列表，并恢复明确的加载状态。 */
  const handleReload = (): void => {
    setLoading(true)
    void loadChannels()
  }

  /** 删除渠道（通过弹窗确认） */
  const handleDeleteRequest = (channel: Channel): void => {
    setDeleteTarget(channel)
  }

  /** 确认删除 */
  const handleDeleteConfirm = async (): Promise<void> => {
    if (!deleteTarget) return
    const target = deleteTarget
    try {
      await window.electronAPI.deleteChannel(target.id)

      // 如果删除的是当前选中的 Agent 渠道，清空选择
      if (agentChannelId === target.id) {
        setAgentChannelId(null)
        setAgentModelId(null)
      }

      await window.electronAPI.updateSettings({
        ...(agentChannelId === target.id && { agentChannelId: undefined, agentModelId: undefined }),
      })

      await loadChannels()
      setDeleteTarget(null)
    } catch (error) {
      console.error('[渠道设置] 删除渠道失败:', error)
    }
  }

  /** 切换渠道启用状态 */
  const handleToggle = async (channel: Channel): Promise<void> => {
    try {
      const savedChannel = await window.electronAPI.updateChannel(channel.id, { enabled: !channel.enabled })
      await loadChannels()
    } catch (error) {
      console.error('[渠道设置] 切换渠道状态失败:', error)
    }
  }

  /** 表单保存回调 */
  const handleFormSaved = async (): Promise<void> => {
    setViewMode('list')
    setEditingChannel(null)
    await loadChannels()
  }

  /** 取消表单 */
  const handleFormCancel = (): void => {
    setViewMode('list')
    setEditingChannel(null)
  }

  // 表单视图
  if (viewMode === 'create' || viewMode === 'edit') {
    return (
      <ChannelForm
        channel={editingChannel}
        onSaved={handleFormSaved}
        onCancel={handleFormCancel}
      />
    )
  }

  // 列表视图
  return (
    <div className="space-y-8">
      {/* 区块一：模型配置 */}
      <SettingsSection
        title="模型配置"
        description="管理 AI 供应商连接，配置 API Key 和可用模型。"
        action={
          <Button size="sm" onClick={() => setViewMode('create')}>
            <Plus size={16} />
            <span>添加配置</span>
          </Button>
        }
      >
        <SettingsCard>
          <PromaProviderCard />
        </SettingsCard>
        {loadError && (
          <div
            role="alert"
            className="flex items-center gap-3 border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
          >
            <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1 break-words">{loadError}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-8 shrink-0"
              aria-label="重新加载渠道"
              title="重新加载渠道"
              onClick={handleReload}
            >
              <RefreshCw className="size-4" />
            </Button>
          </div>
        )}
        {loading ? (
          <div className="text-sm text-muted-foreground py-8 text-center">加载中...</div>
        ) : channels.length === 0 && !loadError ? (
          <SettingsCard divided={false}>
            <div className="text-sm text-muted-foreground py-12 text-center">
              还没有配置任何模型，点击上方"添加配置"开始
            </div>
          </SettingsCard>
        ) : channels.length > 0 ? (
          <SettingsCard>
            {channels.map((channel) => (
              <ChannelRow
                key={channel.id}
                channel={channel}
                onEdit={() => {
                  setEditingChannel(channel)
                  setViewMode('edit')
                }}
                onDelete={() => handleDeleteRequest(channel)}
                onToggle={() => handleToggle(channel)}
              />
            ))}
          </SettingsCard>
        ) : null}
      </SettingsSection>

      {/* 删除确认弹窗 */}
      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null) }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>确定删除渠道？</AlertDialogTitle>
            <AlertDialogDescription>
              确定删除渠道「{deleteTarget?.name}」？此操作不可恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setDeleteTarget(null)}>取消</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function openPromaDownload(): void {
  window.open('https://proma.cool/download', '_blank')
}

// ===== 渠道行子组件 =====

interface ChannelRowProps {
  channel: Channel
  onEdit: () => void
  onDelete: () => void
  onToggle: () => void
}

function ChannelRow({ channel, onEdit, onDelete, onToggle }: ChannelRowProps): React.ReactElement {
  const enabledCount = channel.models.filter((m) => m.enabled).length
  const description = [
    PROVIDER_LABELS[channel.provider],
    enabledCount > 0 ? `${enabledCount} 个模型已启用` : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    <SettingsRow
      label={channel.name}
      icon={<img src={getChannelLogo(channel)} alt="" className="w-8 h-8 rounded" />}
      description={
        <span>{description}</span>
      }
      className="group"
    >
      <div className="flex items-center gap-2">
        {/* 操作按钮 */}
        <button
          onClick={onEdit}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors opacity-0 group-hover:opacity-100"
          title="编辑"
        >
          <Pencil size={14} />
        </button>
        <button
          onClick={onDelete}
          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
          title="删除"
        >
          <Trash2 size={14} />
        </button>

        {/* 启用/关闭开关 */}
        <Switch
          checked={channel.enabled}
          onCheckedChange={onToggle}
        />
      </div>
    </SettingsRow>
  )
}

// ===== Proma 官方供应商推广卡片 =====

function PromaProviderCard(): React.ReactElement {
  return (
    <SettingsRow
      label="Proma"
      icon={<img src={PromaLogo} alt="Proma" className="w-8 h-8 rounded" />}
      description="Proma 商业版｜安全、稳定、优惠的内置模型｜适用于 Chat 与 Agent"
    >
      <Button size="sm" variant="outline" className="gap-1.5" onClick={openPromaDownload}>
        <ExternalLink size={13} />
        <span>下载商业版</span>
      </Button>
    </SettingsRow>
  )
}
