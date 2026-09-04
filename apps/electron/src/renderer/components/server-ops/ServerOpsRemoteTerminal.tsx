import * as React from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import type { ServerOpsTerminalOutputEvent } from '@proma/shared'
import '@xterm/xterm/css/xterm.css'

/** 远程终端属性。 */
export interface ServerOpsRemoteTerminalProps {
  hostId: string
  connectionId: string
}

/** 与本地终端一致的系统等宽字体回退。 */
const TERMINAL_FONT_FAMILY = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "MesloLGS NF", monospace'

/** 渲染并驱动一条已认证 SSH 连接的交互 PTY。 */
export function ServerOpsRemoteTerminal({ hostId, connectionId }: ServerOpsRemoteTerminalProps): React.ReactElement {
  /** xterm 挂载容器。 */
  const hostRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    /** 当前终端 DOM 容器。 */
    const host = hostRef.current
    if (!host) return
    /** 当前远程连接独占的 xterm 实例。 */
    const terminal = new Terminal({
      cursorBlink: true,
      convertEol: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: 13,
      lineHeight: 1.25,
      scrollback: 5_000,
      theme: { background: '#111113', foreground: '#e6e6e9', cursor: '#e6e6e9', selectionBackground: '#3f3f46' },
    })
    /** 根据容器自动计算远程 PTY 行列。 */
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host)
    /** 当前组件是否已经卸载。 */
    let disposed = false
    /** 最后完成渲染并 ACK 的输出序号。 */
    let lastSequence = 0

    /** 调整 xterm 与远程 PTY 尺寸。 */
    const fit = (): void => {
      if (host.clientWidth <= 0 || host.clientHeight <= 0 || host.offsetParent === null) return
      try {
        fitAddon.fit()
        void window.electronAPI.resizeServerOpsTerminal({ hostId, connectionId, cols: Math.max(terminal.cols, 1), rows: Math.max(terminal.rows, 1) })
      } catch {
        // 字体尚未完成测量时由下一次 ResizeObserver 重试。
      }
    }
    /** 渲染有序输出并在 xterm 写入完成后 ACK。 */
    const renderOutput = (event: ServerOpsTerminalOutputEvent): void => {
      if (event.hostId !== hostId || event.connectionId !== connectionId) return
      if (event.sequence <= lastSequence) {
        void window.electronAPI.acknowledgeServerOpsTerminalOutput({ hostId, connectionId, sequence: event.sequence })
        return
      }
      terminal.write(event.data, () => {
        if (disposed) return
        lastSequence = event.sequence
        void window.electronAPI.acknowledgeServerOpsTerminalOutput({ hostId, connectionId, sequence: event.sequence })
      })
    }

    const resizeObserver = new ResizeObserver(fit)
    resizeObserver.observe(host)
    const disposeInput = terminal.onData((data) => {
      void window.electronAPI.writeServerOpsTerminal({ hostId, connectionId, data }).catch(() => undefined)
    })
    const disposeOutput = window.electronAPI.onServerOpsTerminalOutput(renderOutput)
    const disposeExit = window.electronAPI.onServerOpsTerminalExit((event) => {
      if (event.hostId === hostId && event.connectionId === connectionId) terminal.write(`\r\n\x1b[90m${event.message}\x1b[0m\r\n`)
    })
    /** 订阅建立后恢复可能先于组件挂载到达的首批输出。 */
    void window.electronAPI.getServerOpsTerminalSnapshot({ hostId, connectionId }).then((snapshot) => {
      if (!disposed && snapshot) renderOutput(snapshot)
      if (!disposed) terminal.focus()
    }).catch(() => undefined)
    requestAnimationFrame(fit)

    return () => {
      disposed = true
      resizeObserver.disconnect()
      disposeInput.dispose()
      disposeOutput()
      disposeExit()
      terminal.dispose()
    }
  }, [connectionId, hostId])

  return (
    <div className="h-full min-h-0 w-full overflow-hidden bg-[#111113] p-2">
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0" />
    </div>
  )
}
