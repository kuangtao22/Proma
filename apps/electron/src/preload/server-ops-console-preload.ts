import { SERVER_OPS_CONSOLE_IPC_CHANNELS, parseServerOpsConsoleAck, parseServerOpsConsoleExitEvent,
  parseServerOpsConsoleIdentity, parseServerOpsConsoleInput, parseServerOpsConsoleOutputEvent,
  parseServerOpsConsoleResizeInput, parseServerOpsConsoleStartInput } from '@proma/shared'
import type { ServerOpsConsoleAck, ServerOpsConsoleExitEvent, ServerOpsConsoleIdentity, ServerOpsConsoleInput,
  ServerOpsConsoleOutputEvent, ServerOpsConsoleResizeInput, ServerOpsConsoleStartInput } from '@proma/shared'

export interface ServerOpsConsolePreloadIpc {
  invoke(channel: string, input: unknown): Promise<unknown>
  on(channel: string, listener: (_event: unknown, value: unknown) => void): void
  removeListener(channel: string, listener: (_event: unknown, value: unknown) => void): void
}

export interface ServerOpsConsolePreloadApi {
  startServerOpsConsole(input: ServerOpsConsoleStartInput): Promise<ServerOpsConsoleIdentity>
  closeServerOpsConsole(input: ServerOpsConsoleIdentity): Promise<void>
  writeServerOpsConsole(input: ServerOpsConsoleInput): Promise<void>
  resizeServerOpsConsole(input: ServerOpsConsoleResizeInput): Promise<void>
  acknowledgeServerOpsConsoleOutput(input: ServerOpsConsoleAck): Promise<void>
  getServerOpsConsoleSnapshot(input: ServerOpsConsoleIdentity): Promise<ServerOpsConsoleOutputEvent | undefined>
  onServerOpsConsoleOutput(listener: (event: ServerOpsConsoleOutputEvent) => void): () => void
  onServerOpsConsoleExit(listener: (event: ServerOpsConsoleExitEvent) => void): () => void
}

/** 构造严格 Console preload bridge，主进程返回非空 void 时同样 fail closed。 */
export function createServerOpsConsolePreload(ipc: ServerOpsConsolePreloadIpc): ServerOpsConsolePreloadApi {
  const invokeVoid = async (channel: string, input: unknown): Promise<void> => {
    if (await ipc.invoke(channel, input) !== undefined) throw new Error('SERVER_OPS_CONSOLE_RESULT_INVALID')
  }
  return {
    startServerOpsConsole: async (input) => parseServerOpsConsoleIdentity(
      await ipc.invoke(SERVER_OPS_CONSOLE_IPC_CHANNELS.START, parseServerOpsConsoleStartInput(input)),
    ),
    closeServerOpsConsole: (input) => invokeVoid(SERVER_OPS_CONSOLE_IPC_CHANNELS.CLOSE, parseServerOpsConsoleIdentity(input)),
    writeServerOpsConsole: (input) => invokeVoid(SERVER_OPS_CONSOLE_IPC_CHANNELS.WRITE, parseServerOpsConsoleInput(input)),
    resizeServerOpsConsole: (input) => invokeVoid(SERVER_OPS_CONSOLE_IPC_CHANNELS.RESIZE, parseServerOpsConsoleResizeInput(input)),
    acknowledgeServerOpsConsoleOutput: (input) => invokeVoid(SERVER_OPS_CONSOLE_IPC_CHANNELS.ACK_OUTPUT, parseServerOpsConsoleAck(input)),
    getServerOpsConsoleSnapshot: async (input) => {
      const result = await ipc.invoke(SERVER_OPS_CONSOLE_IPC_CHANNELS.SNAPSHOT, parseServerOpsConsoleIdentity(input))
      return result === undefined ? undefined : parseServerOpsConsoleOutputEvent(result)
    },
    onServerOpsConsoleOutput: (listener) => {
      const bridge = (_event: unknown, value: unknown): void => { listener(parseServerOpsConsoleOutputEvent(value)) }
      ipc.on(SERVER_OPS_CONSOLE_IPC_CHANNELS.OUTPUT, bridge)
      return () => ipc.removeListener(SERVER_OPS_CONSOLE_IPC_CHANNELS.OUTPUT, bridge)
    },
    onServerOpsConsoleExit: (listener) => {
      const bridge = (_event: unknown, value: unknown): void => { listener(parseServerOpsConsoleExitEvent(value)) }
      ipc.on(SERVER_OPS_CONSOLE_IPC_CHANNELS.EXIT, bridge)
      return () => ipc.removeListener(SERVER_OPS_CONSOLE_IPC_CHANNELS.EXIT, bridge)
    },
  }
}
