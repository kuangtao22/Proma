import type {
  AgentMessageInvokeResult,
  AgentQueueMessageInput,
  AgentSendInput,
  AgentSubmitOrEnqueueInput,
  AgentSubmitOrEnqueueResult,
} from '@proma/shared'
import { AGENT_IPC_CHANNELS } from '@proma/shared'
import type { IpcMainInvokeEvent, WebContents } from 'electron'
import type { PreparedAgentCanvasMessage } from './agent-canvas-message-preparation'
import { runAgentMessageInvoke } from './agent-canvas-message-preparation'

/** Agent 消息 handler 所需的最小 ipcMain 注册表面。 */
export interface AgentMessageIpcRegistrar {
  handle: (
    channel: string,
    handler: (event: IpcMainInvokeEvent, input: unknown) => Promise<unknown>,
  ) => void
}

/** 三条 Agent 消息 IPC 的可注入生产依赖。 */
export interface AgentMessageIpcDependencies<TSession> {
  ipc: AgentMessageIpcRegistrar
  requireVisibleSession: (sessionId: string) => TSession
  prepareRun: (input: AgentSendInput) => PreparedAgentCanvasMessage<AgentSendInput>
  reserveStart: (sessionId: string) => () => void
  startSessionMirrorRun: (session: TSession) => Promise<unknown>
  runPrepared: (prepared: PreparedAgentCanvasMessage<AgentSendInput>, webContents: WebContents) => Promise<void>
  queueMessage: (input: AgentQueueMessageInput, webContents: WebContents) => Promise<string>
  submitOrEnqueue: (input: AgentSubmitOrEnqueueInput, webContents: WebContents) => Promise<AgentSubmitOrEnqueueResult>
}

/** 注册普通发送、活跃注入与 deferred 原子提交的真实安全信封 handler。 */
export function registerAgentMessageIpcHandlers<TSession>(
  dependencies: AgentMessageIpcDependencies<TSession>,
): void {
  /** 保留统一 guard 名称，供全部 Renderer IPC 安全矩阵审计。 */
  const requireVisibleSession = dependencies.requireVisibleSession
  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.SEND_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<void>> => {
      const sendInput = input as AgentSendInput
      const session = requireVisibleSession(sendInput.sessionId)
      return runAgentMessageInvoke(async () => {
        /** 在任何消息接管副作用前固化 Canvas 引用。 */
        const prepared = dependencies.prepareRun(sendInput)
        const releaseStart = dependencies.reserveStart(sendInput.sessionId)
        try {
          await dependencies.startSessionMirrorRun(session).catch((error) => {
            console.error('[飞书 Session 镜像] 流式卡片初始化失败:', error)
          })
          await dependencies.runPrepared(prepared, event.sender)
        } finally {
          releaseStart()
        }
      })
    },
  )

  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.QUEUE_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<string>> => {
      const queueInput = input as AgentQueueMessageInput
      requireVisibleSession(queueInput.sessionId)
      return runAgentMessageInvoke(() => dependencies.queueMessage(queueInput, event.sender))
    },
  )

  dependencies.ipc.handle(
    AGENT_IPC_CHANNELS.SUBMIT_OR_ENQUEUE_MESSAGE,
    async (event, input): Promise<AgentMessageInvokeResult<AgentSubmitOrEnqueueResult>> => {
      const submitInput = input as AgentSubmitOrEnqueueInput
      requireVisibleSession(submitInput.sessionId)
      return runAgentMessageInvoke(() => dependencies.submitOrEnqueue(submitInput, event.sender))
    },
  )
}
