import * as React from 'react'
import { LiveMarkdownEditor, type LiveMarkdownEditorHandle, type LiveMarkdownTextSelection, type LiveMarkdownPropertyEntry } from '@/components/markdown/LiveMarkdownEditor'
import { serializeFlatLeadingFrontmatter } from '@/components/markdown/live-markdown-frontmatter'
import { createVaultWikiLinks } from './vault-wikilinks'

const MAX_PASTED_IMAGE_BYTES = 10 * 1024 * 1024

async function fileToBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

interface VaultLiveMarkdownEditorProps {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  /** 选区变化由 Vault 外层处理为引用/右侧问答浮窗。 */
  onTextSelectionChange?: (selection: LiveMarkdownTextSelection | null) => void
  /** CodeMirror 异步挂载完成后通知外层，用于恢复阅读位置。 */
  onReady?: () => void
  /** 当前笔记相对 Vault 根目录的路径，用于解析媒体和相对双链。 */
  relativePath: string
  /** 用户点击正文双链时，把原始目标交给 Vault 导航层解析。 */
  onOpenWikiLink: (target: string) => void
}

/** Vault's file adapter around the reusable, domain-neutral Markdown editor. */
export const VaultLiveMarkdownEditor = React.forwardRef<LiveMarkdownEditorHandle, VaultLiveMarkdownEditorProps>(
  function VaultLiveMarkdownEditor({ relativePath, onOpenWikiLink, ...props }, ref): React.ReactElement {
    /** 保存最新双链导航回调，避免回调变化时重建 CodeMirror 扩展。 */
    const onOpenWikiLinkRef = React.useRef(onOpenWikiLink)
    onOpenWikiLinkRef.current = onOpenWikiLink
    /** Vault 专属 CodeMirror 扩展；只创建一次并通过 ref 调用最新导航回调。 */
    const extensions = React.useMemo(
      () => [createVaultWikiLinks((target) => onOpenWikiLinkRef.current(target))],
      [],
    )
    const valueRef = React.useRef(props.value)
    const onChangeRef = React.useRef(props.onChange)
    valueRef.current = props.value
    onChangeRef.current = props.onChange
    const mediaRequestsRef = React.useRef(new Map<string, Promise<string | null>>())
    const resolveImageSrc = React.useCallback((src: string): Promise<string | null> => {
      const cached = mediaRequestsRef.current.get(src)
      if (cached) return cached
      const request = window.electronAPI.resolveVaultMedia(relativePath, src).then((result) => result?.url ?? null)
      mediaRequestsRef.current.set(src, request)
      return request
    }, [relativePath])

    const savePastedImage = React.useCallback(async (file: File): Promise<string | null> => {
      // Reject before allocating raw bytes, a binary string, Base64, and IPC copies.
      if (file.size <= 0 || file.size > MAX_PASTED_IMAGE_BYTES) return null
      return (await window.electronAPI.saveVaultPastedImage({
        noteRelativePath: relativePath,
        mimeType: file.type,
        base64: await fileToBase64(file),
      }))?.src ?? null
    }, [relativePath])

    const handlePropertiesChange = React.useCallback((entries: LiveMarkdownPropertyEntry[], documentValue?: string): void => {
      // This callback is retained by the one-time CodeMirror extension. Prefer
      // its live document snapshot, then the latest controlled value, so a
      // property change cannot reintroduce body text from a previous render.
      const nextValue = serializeFlatLeadingFrontmatter(documentValue ?? valueRef.current, entries)
      onChangeRef.current(nextValue)
    }, [])

    return <LiveMarkdownEditor ref={ref} {...props} extensions={extensions} enableProperties onChangeProperties={handlePropertiesChange} resolveImageSrc={resolveImageSrc} savePastedImage={savePastedImage} />
  },
)
