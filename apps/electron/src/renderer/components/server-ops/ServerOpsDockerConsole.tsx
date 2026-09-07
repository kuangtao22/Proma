import * as React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import type { ServerOpsConsoleIdentity, ServerOpsConsoleOutputEvent } from '@proma/shared'
import type { ServerOpsConsolePreloadApi } from '../../../preload/server-ops-console-preload'

export interface ServerOpsDockerConsoleProps {
  api: ServerOpsConsolePreloadApi
  hostId: string
  containerId: string
  active: boolean
  onSession?(session: ServerOpsConsoleIdentity | null): void
}

/** Console 生命周期实际使用的最小 xterm 接口。 */
export interface ServerOpsDockerConsoleTerminal {
  readonly cols: number
  readonly rows: number
  write(data: string, callback?: () => void): void
  focus(): void
  onData(listener: (data: string) => void): { dispose(): void }
  dispose(): void
}

/** 将 React 宿主与可验证 Console 生命周期连接起来。 */
export interface AttachServerOpsDockerConsoleOptions extends ServerOpsDockerConsoleProps {
  terminal: ServerOpsDockerConsoleTerminal
  fit(): void
  observeResize(callback: () => void): () => void
}

/** 启动 Console、恢复在途输出，并返回精确关闭当前 session 的清理函数。 */
export function attachServerOpsDockerConsole(options: AttachServerOpsDockerConsoleOptions): () => void {
  const { api, hostId, containerId, terminal, fit, observeResize, onSession } = options
  let disposed = false
  let session: ServerOpsConsoleIdentity | null = null

  /** 事件必须与当前服务端 session 完整身份匹配。 */
  const matches = (event: ServerOpsConsoleIdentity): boolean => Boolean(session && event.consoleId === session.consoleId
    && event.hostId === session.hostId && event.connectionId === session.connectionId && event.containerId === session.containerId)
  /** xterm 完成写入后才 ACK，避免释放尚未渲染的输出窗口。 */
  const writeOutput = (event: ServerOpsConsoleOutputEvent): void => {
    if (!matches(event)) return
    terminal.write(event.data, () => { if (!disposed) void api.acknowledgeServerOpsConsoleOutput({ ...event, sequence: event.sequence }) })
  }
  const disposeOutput = api.onServerOpsConsoleOutput(writeOutput)
  const disposeExit = api.onServerOpsConsoleExit((event) => {
    if (matches(event)) terminal.write(`\r\n\x1b[90m${event.message}\x1b[0m\r\n`)
  })
  /** 尺寸变化只发送当前 session 的非零行列。 */
  const resize = (): void => {
    if (disposed) return
    try { fit() } catch { return }
    if (session) void api.resizeServerOpsConsole({ ...session, cols: Math.max(terminal.cols, 1), rows: Math.max(terminal.rows, 1) })
  }
  const disposeResize = observeResize(resize)
  const disposeInput = terminal.onData((data) => { if (session) void api.writeServerOpsConsole({ ...session, data }) })
  resize()
  void api.startServerOpsConsole({ hostId, containerId, cols: Math.max(terminal.cols, 1), rows: Math.max(terminal.rows, 1) })
    .then(async (started) => {
      if (disposed) { await api.closeServerOpsConsole(started); return }
      session = started; onSession?.({ ...started })
      const snapshot = await api.getServerOpsConsoleSnapshot(started)
      if (snapshot) writeOutput(snapshot)
      resize(); terminal.focus()
    })
    .catch(() => { if (!disposed) terminal.write('\r\n\x1b[31m容器终端启动失败\x1b[0m\r\n') })

  return () => {
    disposed = true; disposeResize(); disposeInput.dispose(); disposeOutput(); disposeExit()
    if (session) void api.closeServerOpsConsole(session).catch(() => undefined)
    session = null; onSession?.(null); terminal.dispose()
  }
}

/** 渲染独立容器 PTY；输出完成渲染后才释放 utility 输出窗口。 */
export function ServerOpsDockerConsole({ api, hostId, containerId, active, onSession }: ServerOpsDockerConsoleProps): React.ReactElement {
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const host = hostRef.current
    if (!host || !active) return
    const terminal = new Terminal({ cursorBlink: true, convertEol: false, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12, scrollback: 5_000, theme: { background: '#111113', foreground: '#e6e6e9', cursor: '#e6e6e9', selectionBackground: '#3f3f46' } })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon); terminal.open(host)
    return attachServerOpsDockerConsole({
      api, hostId, containerId, active, onSession, terminal,
      fit: () => fitAddon.fit(),
      observeResize: (callback) => {
        const resizeObserver = new ResizeObserver(callback)
        resizeObserver.observe(host)
        return () => resizeObserver.disconnect()
      },
    })
  }, [active, api, containerId, hostId, onSession])

  return <div ref={hostRef} className="h-full min-h-[240px] w-full bg-[#111113]" aria-label="容器终端" />
}
