import * as React from 'react'
import type { MediaConnectionSummary } from '@proma/shared'
import { Server } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select'

/** Select 内表示明确不绑定的内部值，不写入画布文档。 */
const UNBOUND_CONNECTION_VALUE = '__proma_canvas_comfyui_unbound__'

/** 顶部选择器渲染所需的最小连接事实。 */
export interface CanvasComfyUiConnectionOption {
  id: string
  name: string
  available: boolean
}

/** 全局连接可额外携带归档时间，当前失效选择仍需保留。 */
interface CanvasComfyUiConnectionSource extends MediaConnectionSummary {
  archivedAt?: number
}

/**
 * 从全局目录建立画布服务器选项。
 * @param connections 全局连接摘要，包含启用和失效历史项。
 * @param connectionId 当前画布保存的连接 ID。
 * @returns 全部启用项，以及当前失效项的单独占位。
 */
export function buildCanvasComfyUiConnectionOptions(
  connections: readonly CanvasComfyUiConnectionSource[],
  connectionId: string | null | undefined,
): CanvasComfyUiConnectionOption[] {
  /** 仅 ComfyUI 且仍启用、未归档的连接可供新选择。 */
  const available = connections
    .filter((connection) => connection.driver === 'comfyui'
      && connection.enabled
      && connection.archivedAt === undefined)
    .map((connection) => ({ id: connection.id, name: connection.name, available: true }))
  if (!connectionId || available.some((connection) => connection.id === connectionId)) return available
  /** 当前失效绑定优先复用历史名称；彻底移除时显示稳定 ID，避免偷偷改选。 */
  const selected = connections.find((connection) => connection.id === connectionId)
  return [...available, { id: connectionId, name: selected?.name ?? connectionId, available: false }]
}

/**
 * 解析允许新工作流继承的画布连接。
 * @param connections 已包含当前失效占位的顶部选择器选项。
 * @param connectionId 画布当前保存的默认连接。
 * @returns 仅当当前连接仍可用于新任务时返回其 ID。
 */
export function resolveInheritableCanvasComfyUiConnection(
  connections: readonly CanvasComfyUiConnectionOption[],
  connectionId: string | null | undefined,
): string | null {
  if (!connectionId) return null
  return connections.some((connection) => connection.id === connectionId && connection.available)
    ? connectionId
    : null
}

/** 画布媒体配置弹层中的 ComfyUI 默认服务器选择器。 */
export function CanvasComfyUiConnectionPicker({
  connections,
  connectionId,
  disabled,
  onChange,
}: {
  connections: readonly CanvasComfyUiConnectionOption[]
  connectionId: string | null | undefined
  disabled: boolean
  onChange: (connectionId: string | null) => void
}): React.ReactElement {
  /** 当前显示项允许不可用，确保失效绑定不会在界面上消失。 */
  const selected = connectionId
    ? connections.find((connection) => connection.id === connectionId)
    : undefined
  return (
    <Select
      value={connectionId ?? UNBOUND_CONNECTION_VALUE}
      disabled={disabled}
      onValueChange={(value) => onChange(value === UNBOUND_CONNECTION_VALUE ? null : value)}
    >
      <SelectTrigger
        className="h-8 w-full min-w-0 rounded-sm px-2 text-xs"
        aria-label="画布默认 ComfyUI 服务器"
        title={selected ? `${selected.name}${selected.available ? '' : '（不可用）'}` : '不绑定服务器'}
      >
        <Server className="mr-1.5 size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? `${selected.name}${selected.available ? '' : ' · 不可用'}` : '不绑定服务器'}
        </span>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNBOUND_CONNECTION_VALUE}>不绑定服务器</SelectItem>
        {connections.map((connection) => (
          <SelectItem key={connection.id} value={connection.id} disabled={!connection.available}>
            {connection.name}{connection.available ? '' : ' · 不可用'}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
