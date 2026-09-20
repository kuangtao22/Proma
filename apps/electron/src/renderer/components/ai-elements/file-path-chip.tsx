/**
 * FilePathChip — 文件路径可点击芯片
 *
 * 在 Agent 消息中检测到文件路径时，渲染为可点击的芯片。
 * 支持绝对路径和相对路径（相对于 basePath 解析）。
 * 点击后按用户偏好（标签页 / 侧边分屏）打开文件预览。
 */

import * as React from 'react'
import { useStore } from 'jotai'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { FileTypeIcon } from '@/components/file-browser/FileTypeIcon'
import { useOpenPreview } from '@/components/diff/preview-opener'
import { currentAgentSessionIdAtom } from '@/atoms/agent-atoms'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import {
  getFileName,
  getFilePathDisplayPath,
  isAbsoluteFilePath,
  isAsyncResultCurrent,
  isImageFilePath,
  isLocalFileReference,
  isRelativeFilePath,
  stripLineCol,
} from './file-path-chip-utils'

interface FileResolutionCacheEntry {
  exists: boolean
  resolvedPath?: string
}

/** 文件存在性缓存（模块级共享，避免重复 IPC）。key 含会话授权上下文。 */
const fileExistsCache = new Map<string, FileResolutionCacheEntry>()
/** 同 key 的解析进行中请求，供多个 Chip 复用同一次 IPC。 */
const fileResolutionRequests = new Map<string, Promise<FileResolutionCacheEntry>>()
function existsCacheKey(filePath: string, bases: string[], sessionId?: string): string {
  return `${sessionId ?? ''}\0${filePath}\0${bases.join('\0')}`
}

/**
 * 解析单个文件路径是否在授权范围内存在，并复用缓存与在途请求。
 *
 * 入参 `filePath`：已剥离行号后缀的路径；`bases`：候选根目录；`sessionId`：当前会话（授权上下文）；
 * `options.bypassCache`：为真时忽略已解析缓存（Tooltip 复查需要拿到最新事实）。
 * 返回值：存在性缓存条目，IPC 失败时由调用方决定降级表现。
 */
export function resolveFilePathEntry(
  filePath: string,
  bases: string[],
  sessionId?: string,
  options: { bypassCache?: boolean } = {},
): Promise<FileResolutionCacheEntry> {
  const key = existsCacheKey(filePath, bases, sessionId)
  // 只复用「已解析」结果：「不存在」不能长期缓存，否则本轮之后新建的文件永远无法升级为 Chip。
  const cached = fileExistsCache.get(key)
  if (!options.bypassCache && cached?.exists) return Promise.resolve(cached)

  const inFlight = fileResolutionRequests.get(key)
  if (inFlight) return inFlight

  const promise = window.electronAPI.resolveAuthorizedFilePath(filePath, {
    sessionId,
    candidateBasePaths: bases.length > 0 ? bases : undefined,
  }).then((resolved) => {
    const entry: FileResolutionCacheEntry = {
      exists: resolved !== null,
      ...(resolved?.resolvedPath ? { resolvedPath: resolved.resolvedPath } : {}),
    }
    fileExistsCache.set(key, entry)
    return entry
  }).finally(() => {
    fileResolutionRequests.delete(key)
  })
  fileResolutionRequests.set(key, promise)
  return promise
}

interface FilePathChipProps {
  /** 文件路径（绝对或相对，可能带行号后缀） */
  filePath: string
  /** 基础目录路径（向后兼容，单值） */
  basePath?: string
  /** 多个候选基础目录（如主 cwd + 附加目录），点击时由主进程依次解析 */
  basePaths?: string[]
  className?: string
}

/** 文件路径芯片 — 可点击，触发文件预览 */
export function FilePathChip({ filePath, basePath, basePaths, className }: FilePathChipProps): React.ReactElement {
  const trimmedPath = filePath.trim()
  const { path: cleanPath, suffix: lineColSuffix } = stripLineCol(trimmedPath)
  const filename = getFileName(cleanPath)

  const chipRef = React.useRef<HTMLButtonElement>(null)
  const requestGenerationRef = React.useRef(0)
  const resolutionRequestRef = React.useRef<{ key: string; promise: Promise<void> } | null>(null)
  const mountedRef = React.useRef(true)
  const [fileStatus, setFileStatus] = React.useState<'idle' | 'resolved' | 'broken'>('idle')
  const [resolvedPath, setResolvedPath] = React.useState<string | undefined>()
  const store = useStore()
  const openPreview = useOpenPreview()

  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])

  const displayPath = React.useMemo(() => getFilePathDisplayPath({
    originalPath: trimmedPath,
    resolvedPath,
    lineColSuffix: resolvedPath ? lineColSuffix : '',
  }), [trimmedPath, resolvedPath, lineColSuffix])

  const resolveCurrentPath = React.useCallback((): Promise<void> => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    const key = existsCacheKey(cleanPath, candidateBases, sessionId ?? undefined)
    const inFlight = resolutionRequestRef.current
    if (inFlight?.key === key) return inFlight.promise

    const generation = ++requestGenerationRef.current
    let promise: Promise<void>
    promise = resolveFilePathEntry(cleanPath, candidateBases, sessionId ?? undefined, { bypassCache: true })
      .then((entry) => {
        if (!isAsyncResultCurrent(generation, requestGenerationRef.current, mountedRef.current)) return
        setFileStatus(entry.exists ? 'resolved' : 'broken')
        setResolvedPath(entry.resolvedPath)
      })
      .catch(() => { /* IPC 失败时保留当前状态 */ })
      .finally(() => {
        if (resolutionRequestRef.current?.promise === promise) {
          resolutionRequestRef.current = null
        }
      })
    resolutionRequestRef.current = { key, promise }
    return promise
  }, [cleanPath, candidateBases, store])

  // IntersectionObserver 首次懒检查可使用缓存；Tooltip 打开时会绕过缓存重新解析。
  React.useEffect(() => {
    const el = chipRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return

    requestGenerationRef.current += 1
    mountedRef.current = true
    setFileStatus('idle')
    setResolvedPath(undefined)
    const key = existsCacheKey(cleanPath, candidateBases, store.get(currentAgentSessionIdAtom) ?? undefined)
    const cached = fileExistsCache.get(key)
    if (cached) {
      setFileStatus(cached.exists ? 'resolved' : 'broken')
      setResolvedPath(cached.resolvedPath)
      return () => {
        mountedRef.current = false
        requestGenerationRef.current += 1
      }
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return
        observer.disconnect()
        void resolveCurrentPath()
      },
      { threshold: 0 },
    )
    observer.observe(el)
    return () => {
      mountedRef.current = false
      requestGenerationRef.current += 1
      observer.disconnect()
    }
  }, [cleanPath, candidateBases, resolveCurrentPath, store])

  const handleTooltipOpenChange = React.useCallback((open: boolean) => {
    if (open) void resolveCurrentPath()
  }, [resolveCurrentPath])

  const handleClick = React.useCallback(() => {
    const sessionId = store.get(currentAgentSessionIdAtom)
    if (!sessionId) return

    openPreview(sessionId, {
      filePath: cleanPath,
      previewOnly: true,
      basePaths: candidateBases.length > 0 ? candidateBases : undefined,
    })
  }, [store, openPreview, cleanPath, candidateBases])

  const handleShowInFolder = React.useCallback(() => {
    const bases = candidateBases.length > 0 ? candidateBases : undefined
    const sessionId = store.get(currentAgentSessionIdAtom)
    window.electronAPI.showItemInFolder(cleanPath, { sessionId: sessionId ?? undefined, candidateBasePaths: bases })
      .then((ok) => { if (!ok) toast.error(`未找到文件：${filename}`) })
      .catch(() => toast.error(`未找到文件：${filename}`))
  }, [cleanPath, candidateBases, filename, store])

  return (
    <ContextMenu>
      <Tooltip onOpenChange={handleTooltipOpenChange}>
        <ContextMenuTrigger asChild>
          <TooltipTrigger asChild>
            <button
              ref={chipRef}
              type="button"
              onClick={handleClick}
              className={cn(
                'inline-flex items-center gap-[0.25em] rounded px-[0.35em] py-[0.15em] text-[0.875em] font-medium leading-none',
                'cursor-pointer transition-colors duration-150',
                'align-baseline not-prose',
                fileStatus === 'broken'
                  ? 'opacity-50 border border-dashed border-muted-foreground/30 text-muted-foreground hover:opacity-70 hover:bg-muted/20'
                  : 'bg-primary/10 text-primary hover:bg-primary/20',
                className,
              )}
            >
              <FileTypeIcon name={filename} isDirectory={false} size={12} />
              <span className="truncate max-w-[240px] leading-none">{filename}{lineColSuffix}</span>
            </button>
          </TooltipTrigger>
        </ContextMenuTrigger>
        <TooltipContent side="bottom" className="max-w-[400px] break-all font-mono text-[11px]">
          {fileStatus === 'broken' ? `文件不存在: ${displayPath}` : displayPath}
        </TooltipContent>
      </Tooltip>
      <ContextMenuContent className="w-48 z-[9999]">
        <ContextMenuItem onClick={handleClick}>
          打开预览
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={handleShowInFolder}>
          在文件管理器中显示
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface ResolvableFilePathChipProps extends FilePathChipProps {
  /** 路径未通过主进程解析时保留的原始节点，避免渲染出不可用的 Chip。 */
  fallback: React.ReactElement
}

/**
 * 用于模型自由文本中的路径候选：只有文件在授权范围内存在时才升级为 Chip，
 * 解析期间与解析失败都保留调用方提供的原始 Markdown 外观。
 *
 * 入参：同 FilePathChip，另加 `fallback`。
 * 返回值：已解析时渲染 FilePathChip，否则渲染 fallback。
 */
export function ResolvableFilePathChip({
  fallback,
  filePath,
  basePath,
  basePaths,
  className,
}: ResolvableFilePathChipProps): React.ReactElement {
  const store = useStore()
  const candidateBases = React.useMemo<string[]>(() => {
    if (basePaths && basePaths.length > 0) return basePaths.filter(Boolean)
    if (basePath) return [basePath]
    return []
  }, [basePath, basePaths])
  const cleanPath = React.useMemo(() => stripLineCol(filePath.trim()).path, [filePath])
  const sessionId = store.get(currentAgentSessionIdAtom) ?? undefined
  const resolutionKey = React.useMemo(
    () => existsCacheKey(cleanPath, candidateBases, sessionId),
    [candidateBases, cleanPath, sessionId],
  )
  const [resolvedKey, setResolvedKey] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    setResolvedKey(null)
    void resolveFilePathEntry(cleanPath, candidateBases, sessionId)
      .then((entry) => {
        if (!cancelled && entry.exists) setResolvedKey(resolutionKey)
      })
      .catch(() => {
        // IPC 失败时保持原始 Markdown 外观，不制造不可点击的 Chip。
        if (!cancelled) setResolvedKey(null)
      })
    return () => { cancelled = true }
  }, [candidateBases, cleanPath, sessionId, resolutionKey])

  if (resolvedKey !== resolutionKey) return fallback
  return <FilePathChip filePath={filePath} basePath={basePath} basePaths={basePaths} className={className} />
}

export { isAbsoluteFilePath, isImageFilePath, isLocalFileReference, isRelativeFilePath }
