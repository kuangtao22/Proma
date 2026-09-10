import * as React from 'react'
import { getCanvasMediaSourcePort } from '@proma/shared'
import type { CanvasDocument, CanvasImagePreview, CanvasNode } from '@proma/shared'
import { ImageOff, LoaderCircle } from 'lucide-react'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

/** 编辑区始终保留节点依赖身份，不转换成固定素材引用。 */
export interface CanvasMediaSourcePickerValue {
  nodeId: string
  outputKey: string
}

/** 来源模块的公开输出目录，不包含媒体字节或磁盘路径。 */
interface CanvasMediaSourceOutput {
  key: string
  mediaKind: string
  role?: string
}

/** 来源选择只消费已授权当前图和按需读取的输出合同。 */
export interface CanvasMediaSourcePickerProps {
  document: CanvasDocument
  imagePreviews?: readonly CanvasImagePreview[]
  value: CanvasMediaSourcePickerValue | null
  inputKind: 'text' | 'image' | 'audio' | 'video' | 'number' | 'boolean'
  label?: string
  targetNodeId?: string
  disabled?: boolean
  loadMediaConfig?: (node: Extract<CanvasNode, { kind: 'audio' | 'video' }>) => Promise<readonly CanvasMediaSourceOutput[]>
  onChange: (value: CanvasMediaSourcePickerValue) => void
}

/** 返回全部兼容输出，不默认替用户选择第一个角色或版本。 */
export function selectCanvasMediaOutputs(
  outputs: readonly CanvasMediaSourceOutput[],
  inputKind: CanvasMediaSourcePickerProps['inputKind'],
): CanvasMediaSourceOutput[] {
  return outputs.filter((output) => output.mediaKind === inputKind)
}

/** 返回当前图中可形成正式类型化边的来源，排除目标自身。 */
export function getCanvasMediaSourceNodes(
  document: CanvasDocument,
  inputKind: CanvasMediaSourcePickerProps['inputKind'],
  targetNodeId?: string,
): CanvasNode[] {
  return document.nodes.filter((node) => node.id !== targetNodeId && (inputKind === 'text'
    ? node.kind === 'agent' || node.kind === 'document'
    : (inputKind === 'image' || inputKind === 'audio' || inputKind === 'video') && node.kind === inputKind))
}

/** 缩略图只从当前窗口已有授权预览匹配，不推导路径或申请原图。 */
export function previewForNode(node: CanvasNode, previews: readonly CanvasImagePreview[]): CanvasImagePreview | undefined {
  if (node.kind !== 'image' || !node.adoptedAssetId) return undefined
  return previews.find((preview) => preview.assetId === node.adoptedAssetId)
}

/** 类型名称展示语义，技术输出 key 保留在次级信息。 */
const NODE_KIND_LABELS = { agent: 'Agent 文本', document: '文档', image: '图片', audio: '音频', video: '视频', webview: '原型' }
/** 输出角色不会被翻译成新的业务 key。 */
const OUTPUT_ROLE_LABELS: Record<string, string> = { primary: '主输出', preview: '预览', auxiliary: '辅助输出' }

/** 从当前图选择确切来源；AV 的 key 由异步模块目录提供，切换和卸载废弃旧目录。 */
export function CanvasMediaSourcePicker({
  document, imagePreviews = [], value, inputKind, label = 'Canvas', targetNodeId,
  disabled = false, loadMediaConfig, onChange,
}: CanvasMediaSourcePickerProps): React.ReactElement {
  /** 目录状态仅用于当前选择，不回写用户草稿。 */
  const [catalog, setCatalog] = React.useState<{ identity: string; outputs: CanvasMediaSourceOutput[]; error: string | null } | null>(null)
  /** 回调更新不触发重复请求，读取由目标与图revision驱动。 */
  const loaderRef = React.useRef(loadMediaConfig)
  loaderRef.current = loadMediaConfig
  const candidates = getCanvasMediaSourceNodes(document, inputKind, targetNodeId)
  const selectedNode = candidates.find((node) => node.id === value?.nodeId)
  const mediaNode = selectedNode?.kind === 'audio' || selectedNode?.kind === 'video' ? selectedNode : null
  const identity = JSON.stringify([document.projectId, document.canvasId, document.revision, mediaNode?.id, mediaNode?.mediaModuleId, inputKind])
  const currentCatalog = catalog?.identity === identity ? catalog : null
  const loading = Boolean(mediaNode && !currentCatalog)
  const invalid = Boolean(value?.nodeId && !selectedNode)

  React.useEffect(() => {
    /** effect 的存活标记隔离节点切换、模块替换、图更新与卸载后的迟到响应。 */
    let active = true
    setCatalog(null)
    if (!mediaNode) return
    const loader = loaderRef.current
    if (!loader) { setCatalog({ identity, outputs: [], error: '输出目录暂不可用，请刷新重试。' }); return }
    void loader(mediaNode).then((outputs) => {
      if (active) setCatalog({ identity, outputs: selectCanvasMediaOutputs(outputs, inputKind), error: null })
    }).catch(() => {
      if (active) setCatalog({ identity, outputs: [], error: '读取节点输出失败，请刷新重试。' })
    })
    return () => { active = false }
  }, [identity])

  /** 选择AV先保留节点，再由用户选择确切输出；固定类型一次完成。 */
  const selectNode = (nodeId: string): void => {
    const node = candidates.find((candidate) => candidate.id === nodeId)
    if (!node) return
    onChange({ nodeId, outputKey: node.kind === 'audio' || node.kind === 'video' ? '' : getCanvasMediaSourcePort(node.kind) })
  }
  const invalidOutput = Boolean(value?.outputKey && selectedNode && (mediaNode
    ? currentCatalog && !currentCatalog.outputs.some((output) => output.key === value.outputKey)
    : value.outputKey !== getCanvasMediaSourcePort(selectedNode.kind)))

  return <div className="grid min-w-0 gap-1.5">
    <Select value={selectedNode?.id ?? ''} disabled={disabled} onValueChange={selectNode}>
      <SelectTrigger aria-label={`${label} 来源节点`} className="min-w-0 text-xs"><SelectValue placeholder="选择来源节点" /></SelectTrigger>
      <SelectContent>
        {candidates.map((node) => {
          const preview = previewForNode(node, imagePreviews)
          return <SelectItem key={node.id} value={node.id}><span className="flex min-w-0 items-center gap-2">
            {preview ? <img src={preview.previewUrl} alt="" loading="lazy" className="size-6 rounded-sm object-cover" /> : node.kind === 'image' ? <ImageOff className="size-4 text-muted-foreground" /> : null}
            <span className="min-w-0 truncate">{node.title || node.id}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground">{NODE_KIND_LABELS[node.kind]}</span>
          </span></SelectItem>
        })}
        {candidates.length === 0 ? <p className="px-3 py-2 text-xs text-muted-foreground">暂无兼容的来源节点</p> : null}
      </SelectContent>
    </Select>
    {invalid ? <p className="text-xs text-amber-600" role="status">原来源节点已不存在或类型不匹配，请重新选择。</p> : null}
    {mediaNode ? <Select value={currentCatalog?.outputs.some((output) => output.key === value?.outputKey) ? value?.outputKey : ''}
      disabled={disabled || loading || !currentCatalog?.outputs.length} onValueChange={(outputKey) => onChange({ nodeId: mediaNode.id, outputKey })}>
      <SelectTrigger aria-label={`${label} 来源输出`} className="min-w-0 text-xs">
        {loading ? <span className="flex gap-1"><LoaderCircle className="size-3 animate-spin" />读取输出</span> : <SelectValue placeholder="选择输出" />}
      </SelectTrigger>
      <SelectContent>{currentCatalog?.outputs.map((output) => <SelectItem key={output.key} value={output.key}>
        {OUTPUT_ROLE_LABELS[output.role ?? ''] ?? '输出'} · {output.key}
      </SelectItem>)}</SelectContent>
    </Select> : null}
    {currentCatalog?.error ? <p className="text-xs text-destructive" role="alert">{currentCatalog.error}</p>
      : mediaNode && currentCatalog && currentCatalog.outputs.length === 0 ? <p className="text-xs text-amber-600" role="status">该节点尚未配置兼容输出。</p> : null}
    {invalidOutput ? <p className="text-xs text-amber-600" role="status">原输出已失效，请重新选择输出。</p> : null}
    {value?.outputKey ? <p className="break-all font-mono text-[10px] text-muted-foreground">输出 {value.outputKey}</p> : null}
  </div>
}
