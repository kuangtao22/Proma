import { randomUUID } from 'node:crypto'
import type {
  AgentRuntimeEvent,
  AgentRuntimeRequest,
  AgentRuntimeError,
  SDKMessage,
  SDKUserMessageInput,
  SendQueuedMessageOptions,
} from '@proma/shared'
import {
  AGENT_RUNTIME_METHODS,
} from '@proma/shared'
import type { PermissionResult, CanUseToolOptions } from '../agent-permission-service'
import { AgentRuntimeClient } from '../agent-runtime-client'
import type { PiAgentQueryOptions } from './pi-agent-adapter'

type PendingQuery = {
  queryId: string
  sessionId: string
  input: PiAgentQueryOptions
  client: AgentRuntimeClient
  queue: AsyncEventQueue<SDKMessage>
  accepted: boolean
  ended: boolean
  runtimeFailed: boolean
  runtimeAbortPromise?: Promise<void>
  forceClosePromise?: Promise<void>
}

type CapabilityRequest = {
  controller: AbortController
  queryId: string
}

type AsyncEventQueue<T> = {
  push: (value: T) => void
  end: () => void
  fail: (error: unknown) => void
  next: () => Promise<IteratorResult<T>>
}

/**
 * Main-process facade for one utility process per active Agent session.
 * Only serializable query data crosses the boundary; Proma callbacks return
 * through capability RPC so business ownership stays in the main process.
 */
export class PiUtilityAdapter {
  private readonly pendingQueries = new Map<string, PendingQuery>()
  private readonly capabilityAbortControllers = new Map<string, CapabilityRequest>()

  async *query(input: PiAgentQueryOptions): AsyncIterable<SDKMessage> {
    const queryId = randomUUID()
    const client = new AgentRuntimeClient({ sessionId: input.sessionId })
    const pending: PendingQuery = {
      queryId,
      sessionId: input.sessionId,
      input,
      client,
      queue: createAsyncEventQueue<SDKMessage>(),
      accepted: false,
      ended: false,
      runtimeFailed: false,
    }
    this.pendingQueries.set(queryId, pending)
    client.setRequestHandler((request) => this.handleRuntimeRequest(request))
    const unsubscribe = client.onEvent((event) => this.handleRuntimeEvent(event))

    try {
      await client.call(
        AGENT_RUNTIME_METHODS.QUERY_START,
        { queryId, input: serializeQueryInput(input) },
        { queryId },
      )
      pending.accepted = true

      while (true) {
        const result = await pending.queue.next()
        if (result.done) return
        yield result.value
      }
    } catch (error) {
      pending.queue.fail(error)
      throw error
    } finally {
      pending.ended = true
      unsubscribe()
      this.pendingQueries.delete(queryId)
      if (pending.forceClosePromise) {
        await pending.forceClosePromise
      } else {
        if (pending.accepted && !pending.runtimeFailed) await this.requestRuntimeAbort(pending)
        await client.stop()
      }
    }
  }

  abort(sessionId: string): void {
    const pending = this.findPending(sessionId)
    if (!pending) return
    void this.requestRuntimeAbort(pending)
  }

  /** 先结束 utility runtime 与事件队列，使调用方随后可等待 async generator cleanup。 */
  forceCloseQuery(sessionId: string): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) return Promise.resolve()
    return this.forceClosePendingQuery(pending)
  }

  async sendQueuedMessage(
    sessionId: string,
    message: SDKUserMessageInput,
    options?: SendQueuedMessageOptions,
  ): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) throw new Error('当前会话没有正在运行的 Agent')
    const { onAccepted: _onAccepted, ...serializableOptions } = options ?? {}
    await pending.client.call(
      AGENT_RUNTIME_METHODS.QUERY_SEND_QUEUED_MESSAGE,
      { sessionId, message, options: serializableOptions },
      { queryId: pending.queryId },
    )
    options?.onAccepted?.()
  }

  async setPermissionMode(sessionId: string, mode: string): Promise<void> {
    const pending = this.findPending(sessionId)
    if (!pending) return
    await pending.client.call(
      AGENT_RUNTIME_METHODS.QUERY_SET_PERMISSION_MODE,
      { sessionId, mode },
      { queryId: pending.queryId },
    )
  }

  dispose(): void {
    for (const pending of this.pendingQueries.values()) {
      if (!pending.forceClosePromise) pending.runtimeFailed = true
      void this.forceClosePendingQuery(pending).catch((error) => {
        console.warn(`[PiUtilityAdapter] dispose failed: sessionId=${pending.sessionId}`, error)
      })
    }
    for (const { controller } of this.capabilityAbortControllers.values()) controller.abort()
    this.capabilityAbortControllers.clear()
  }

  async handleRuntimeRequest(request: AgentRuntimeRequest): Promise<unknown> {
    const payload = request.payload as Record<string, unknown> | undefined
    const queryId = typeof payload?.queryId === 'string' ? payload.queryId : undefined
    const pending = queryId ? this.pendingQueries.get(queryId) : undefined

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CANCEL) {
      const requestId = typeof payload?.requestId === 'string' ? payload.requestId : ''
      this.capabilityAbortControllers.get(requestId)?.controller.abort()
      return { accepted: true }
    }

    if (!pending) throw new Error(`No active Agent query: ${queryId ?? 'unknown'}`)

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CAN_USE_TOOL) {
      if (!pending.input.canUseTool) throw new Error(`No canUseTool handler: ${pending.sessionId}`)
      const controller = new AbortController()
      this.capabilityAbortControllers.set(request.requestId, { controller, queryId: pending.queryId })
      try {
        const options = (payload?.options && typeof payload.options === 'object' ? payload.options : {}) as Record<string, unknown>
        return await pending.input.canUseTool(
          String(payload?.toolName ?? ''),
          asRecord(payload?.input),
          { ...options, signal: controller.signal } as CanUseToolOptions,
        ) as PermissionResult
      } finally {
        this.capabilityAbortControllers.delete(request.requestId)
      }
    }

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CUSTOM_TOOL) {
      const toolName = String(payload?.toolName ?? '')
      const tool = pending.input.customTools?.find((candidate) => candidate.name === toolName)
      if (!tool) throw new Error(`No custom tool handler: ${toolName}`)
      const controller = new AbortController()
      this.capabilityAbortControllers.set(request.requestId, { controller, queryId: pending.queryId })
      try {
        const execute = tool.execute as unknown as (
          toolCallId: string,
          input: Record<string, unknown>,
          signal: AbortSignal,
        ) => Promise<unknown>
        return await execute(String(payload?.toolCallId ?? ''), asRecord(payload?.input), controller.signal)
      } finally {
        this.capabilityAbortControllers.delete(request.requestId)
      }
    }

    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_CODEX_OAUTH_REFRESHED) {
      await pending.input.onCodexOAuthCredentialsRefreshed?.(payload?.credentials as never)
      return { accepted: true }
    }
    if (request.method === AGENT_RUNTIME_METHODS.CAPABILITY_XAI_OAUTH_REFRESHED) {
      await pending.input.onXaiOAuthCredentialsRefreshed?.(payload?.credentials as never)
      return { accepted: true }
    }

    throw new Error(`Unsupported Agent runtime request: ${request.method}`)
  }

  private findPending(sessionId: string): PendingQuery | undefined {
    return Array.from(this.pendingQueries.values()).find((item) => item.sessionId === sessionId)
  }

  /** 复用单个 runtime abort 请求，避免 stop 与 drain timeout 重复终止同一 query。 */
  private requestRuntimeAbort(pending: PendingQuery): Promise<void> {
    if (pending.runtimeFailed) return Promise.resolve()
    pending.runtimeAbortPromise ??= pending.client.call(
      AGENT_RUNTIME_METHODS.QUERY_ABORT,
      { queryId: pending.queryId, sessionId: pending.sessionId },
      { queryId: pending.queryId, timeoutMs: 5_000 },
    ).then(() => undefined).catch((error) => {
      console.warn(`[PiUtilityAdapter] abort failed: sessionId=${pending.sessionId}`, error)
    })
    return pending.runtimeAbortPromise
  }

  /** 结束 pending next 的队列并等待 utility runtime 真正停止；并发调用共享同一 Promise。 */
  private forceClosePendingQuery(pending: PendingQuery): Promise<void> {
    if (pending.forceClosePromise) return pending.forceClosePromise
    pending.forceClosePromise = (async () => {
      try {
        if (pending.accepted && !pending.runtimeFailed) await this.requestRuntimeAbort(pending)
      } finally {
        pending.queue.end()
      }
      await pending.client.stop()
    })()
    // dispose 是同步入口；为共享 Promise 预装拒绝消费者，调用方仍可 await 原 Promise 得到失败。
    pending.forceClosePromise.catch(() => {})
    return pending.forceClosePromise
  }

  private handleRuntimeEvent(event: AgentRuntimeEvent): void {
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_CRASHED) {
      const error = toRuntimeError(event.payload)
      const failed = Array.from(this.pendingQueries.values())
        .filter((pending) => pending.sessionId === event.sessionId)
      for (const pending of failed) {
        pending.runtimeFailed = true
        pending.queue.fail(error)
      }
      for (const [requestId, capability] of this.capabilityAbortControllers) {
        if (failed.some((pending) => pending.queryId === capability.queryId)) {
          capability.controller.abort()
          this.capabilityAbortControllers.delete(requestId)
        }
      }
      return
    }

    const payload = event.payload as Record<string, unknown> | undefined
    const queryId = event.queryId
      ?? (typeof payload?.queryId === 'string' ? payload.queryId : undefined)
    if (!queryId) return
    const pending = this.pendingQueries.get(queryId)
    if (!pending) return

    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY) {
      const message = payload?.message
      if (message && typeof message === 'object') pending.queue.push(message as SDKMessage)
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_END) {
      pending.queue.end()
      return
    }
    if (event.method === AGENT_RUNTIME_METHODS.EVENT_QUERY_ERROR) {
      pending.queue.fail(toRuntimeError(payload?.error))
      return
    }
    if (event.method !== AGENT_RUNTIME_METHODS.EVENT_QUERY_CALLBACK) return

    const callback = payload?.callback
    const callbackPayload = payload?.payload as Record<string, unknown> | undefined
    switch (callback) {
      case 'session_id':
        pending.input.onSessionId?.(String(callbackPayload?.sdkSessionId ?? ''), callbackPayload?.sessionFile as string | undefined)
        break
      case 'pi_entry_bindings':
        pending.input.onPiEntryBindings?.((callbackPayload?.bindings ?? {}) as Record<string, string>)
        break
      case 'model_resolved':
        pending.input.onModelResolved?.(String(callbackPayload?.model ?? ''))
        break
      case 'context_window':
        pending.input.onContextWindow?.(Number(callbackPayload?.contextWindow ?? 0))
        break
      case 'retry':
        pending.input.onRetry?.(callbackPayload?.update as never)
        break
      case 'skill_activated':
        pending.input.onSkillActivated?.(
          (callbackPayload?.activations ?? []) as never,
          String(callbackPayload?.userMessageUuid ?? ''),
        )
        break
    }
  }
}

function serializeQueryInput(input: PiAgentQueryOptions): Record<string, unknown> {
  const {
    abortSignal: _abortSignal,
    canUseTool: _canUseTool,
    customTools,
    onSessionId: _onSessionId,
    onPiEntryBindings: _onPiEntryBindings,
    onModelResolved: _onModelResolved,
    onContextWindow: _onContextWindow,
    onRetry: _onRetry,
    onSkillActivated: _onSkillActivated,
    onCodexOAuthCredentialsRefreshed: _onCodexOAuthCredentialsRefreshed,
    onXaiOAuthCredentialsRefreshed: _onXaiOAuthCredentialsRefreshed,
    ...serializable
  } = input
  const serializedCustomTools = (customTools ?? []).map((tool) => {
    const { execute: _execute, ...descriptor } = tool as unknown as Record<string, unknown>
    return descriptor
  })
  return {
    ...serializable,
    ...(serializedCustomTools.length > 0 ? { customTools: serializedCustomTools } : {}),
  }
}

function createAsyncEventQueue<T>(): AsyncEventQueue<T> {
  const values: T[] = []
  const waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = []
  let ended = false
  let failure: unknown

  return {
    push(value) {
      if (ended || failure !== undefined) return
      const waiter = waiters.shift()
      if (waiter) waiter.resolve({ done: false, value })
      else values.push(value)
    },
    end() {
      if (ended || failure !== undefined) return
      ended = true
      while (waiters.length > 0) waiters.shift()!.resolve({ done: true, value: undefined })
    },
    fail(error) {
      if (ended || failure !== undefined) return
      failure = error
      while (waiters.length > 0) waiters.shift()!.reject(error)
    },
    async next() {
      if (values.length > 0) return { done: false, value: values.shift()! }
      if (failure !== undefined) throw failure
      if (ended) return { done: true, value: undefined }
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }))
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function toRuntimeError(value: unknown): Error {
  if (value && typeof value === 'object' && typeof (value as AgentRuntimeError).message === 'string') {
    const error = new Error((value as AgentRuntimeError).message)
    Object.assign(error, value)
    return error
  }
  return new Error(typeof value === 'string' ? value : 'Agent utility query failed')
}
