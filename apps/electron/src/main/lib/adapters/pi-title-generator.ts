/**
 * 通过 Pi ModelRuntime 发起隔离的轻量标题请求。
 *
 * 标题请求与前台 Agent 共享模型、渠道、认证、协议和代理解析，但使用独立
 * session，不写入当前会话历史，也不加载 Agent 工具。
 */

import { randomUUID } from 'node:crypto'
import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ModelsSimpleStreamOptions,
} from '@earendil-works/pi-ai'
import type { CodexOAuthCredentials, ProviderType, XaiOAuthCredentials } from '@proma/shared'
import type { Dispatcher } from 'undici'
import { buildModel } from './pi-model-registry'
import {
  closePiRequestProxyDispatcher,
  createPiRequestProxyDispatcher,
  installPiRequestProxyFetch,
  runWithPiRequestProxy,
} from './pi-request-proxy'

type PiSdk = typeof import('@earendil-works/pi-coding-agent')
type PiTitleTransport = 'auto' | 'sse'

/** 标题最多允许模型返回的 Token 数。 */
const TITLE_MAX_OUTPUT_TOKENS = 50
/** 标题请求的最长等待时间，避免后台写入长期占用 generation。 */
const TITLE_REQUEST_TIMEOUT_MS = 30_000

/** 标题请求所需的当前渠道与模型配置。 */
export interface PiTitleGenerationInput {
  channelId: string
  channelName: string
  provider: ProviderType
  modelId: string
  baseUrl?: string
  apiKey: string
  prompt: string
  proxyUrl?: string
  signal?: AbortSignal
  codexOAuthCredentials?: CodexOAuthCredentials
  xaiOAuthCredentials?: XaiOAuthCredentials
  onCodexOAuthCredentialsRefreshed?: (credentials: CodexOAuthCredentials) => void | Promise<void>
  onXaiOAuthCredentialsRefreshed?: (credentials: XaiOAuthCredentials) => void | Promise<void>
}

/** 可注入测试的 Pi 标题请求运行时最小契约。 */
export interface PiTitleRuntime {
  complete: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions & {
      reasoningEffort?: 'none'
      textVerbosity?: 'low'
      toolChoice?: 'none'
    },
  ) => Promise<Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>>
  completeSimple: (
    model: Model<Api>,
    context: Context,
    options?: ModelsSimpleStreamOptions,
  ) => Promise<Pick<AssistantMessage, 'content' | 'stopReason' | 'errorMessage'>>
}

/** 可注入测试的代理请求环境。 */
export interface PiTitleRequestEnvironment {
  dispatcher?: Dispatcher
  installRequestProxyFetch: () => void
  runWithRequestProxy: <T>(dispatcher: Dispatcher | undefined, operation: () => T) => T
  closeRequestProxyDispatcher: (dispatcher: Dispatcher | undefined) => Promise<void>
}

/** 标题请求的代理与传输设置。 */
export interface PiTitleConnectionSettings {
  proxyUrl?: string
  noProxy?: string
  transport: PiTitleTransport
}

/** 按大小写不敏感方式读取代理环境变量。 */
function getCaseInsensitiveEnvironmentValue(key: string): string | undefined {
  /** 优先读取调用方给出的标准大小写名称。 */
  const exact = process.env[key]
  if (exact?.trim()) return exact.trim()
  /** 兼容 Windows 等大小写不敏感环境中的变量名称。 */
  const matchedKey = Object.keys(process.env).find((name) => name.toLowerCase() === key.toLowerCase())
  /** 仅返回非空的规范化环境值。 */
  const value = matchedKey ? process.env[matchedKey] : undefined
  return value?.trim() || undefined
}

/**
 * 标题请求沿用前台 Pi Agent 的连接选择：无代理时使用 auto，有 HTTP 代理时
 * 使用可携带 undici dispatcher 的 SSE。
 */
export function resolvePiTitleConnectionSettings(proxyUrl?: string): PiTitleConnectionSettings {
  /** 显式代理优先，其次沿用进程级标准代理变量。 */
  const resolvedProxyUrl = proxyUrl?.trim()
    || getCaseInsensitiveEnvironmentValue('HTTPS_PROXY')
    || getCaseInsensitiveEnvironmentValue('HTTP_PROXY')
    || getCaseInsensitiveEnvironmentValue('ALL_PROXY')
  /** NO_PROXY 继续交给 Pi 代理层判断直连目标。 */
  const noProxy = getCaseInsensitiveEnvironmentValue('NO_PROXY')

  return {
    ...(resolvedProxyUrl && { proxyUrl: resolvedProxyUrl }),
    ...(noProxy && { noProxy }),
    transport: resolvedProxyUrl ? 'sse' : 'auto',
  }
}

/** 从 Pi 响应中提取可见文本，忽略 reasoning 和工具内容。 */
export function extractPiResponseText(content: AssistantMessage['content']): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

/** 执行一次不主动启用推理、不加载工具且总会释放代理资源的标题请求。 */
export async function completePiTitleRequest(
  runtime: PiTitleRuntime,
  model: Model<Api>,
  prompt: string,
  environment: PiTitleRequestEnvironment,
  signal?: AbortSignal,
  transport: PiTitleTransport = 'auto',
): Promise<string | null> {
  try {
    environment.installRequestProxyFetch()
    /** 独立上下文确保标题请求不进入前台 Agent 历史。 */
    const context: Context = {
      messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
    }
    /** 所有协议共享的轻量请求约束；不传 reasoning，由 completeSimple 使用最低开销路径。 */
    const options: ModelsSimpleStreamOptions = {
      sessionId: randomUUID(),
      transport,
      maxTokens: TITLE_MAX_OUTPUT_TOKENS,
      timeoutMs: TITLE_REQUEST_TIMEOUT_MS,
      maxRetries: 0,
      signal,
    }
    /** Codex 支持显式 none；其它协议由 completeSimple 映射各自的关闭或最低开销语义。 */
    const response = await environment.runWithRequestProxy(environment.dispatcher, () => (
      model.api === 'openai-codex-responses'
        ? runtime.complete(model, context, {
            ...options,
            // Codex 支持明确的 none；直接指定可避免服务端应用默认推理档位。
            reasoningEffort: 'none',
            textVerbosity: 'low',
            toolChoice: 'none',
          })
        : runtime.completeSimple(model, context, options)
    ))

    if (response.stopReason === 'error' || response.stopReason === 'aborted') {
      throw new Error(response.errorMessage?.trim() || 'Pi 标题请求未完成')
    }

    return extractPiResponseText(response.content).trim() || null
  } finally {
    await environment.closeRequestProxyDispatcher(environment.dispatcher)
  }
}

/** 使用当前 Agent 渠道的 Pi 模型生成独立语义标题。 */
export async function generatePiTitle(input: PiTitleGenerationInput): Promise<string | null> {
  /** 动态加载保持 Pi runtime 为 Electron external，避免被主进程 bundle 内联。 */
  const sdk: PiSdk = await import('@earendil-works/pi-coding-agent')
  /** 使用当前渠道配置构建一次性 Pi 模型运行时。 */
  const { modelRuntime, model } = await buildModel(sdk, {
    sessionId: randomUUID(),
    model: input.modelId,
    apiKey: input.apiKey,
    baseUrl: input.baseUrl,
    provider: input.provider,
    channelId: input.channelId,
    channelName: input.channelName,
    codexOAuthCredentials: input.codexOAuthCredentials,
    xaiOAuthCredentials: input.xaiOAuthCredentials,
    onCodexOAuthCredentialsRefreshed: input.onCodexOAuthCredentialsRefreshed,
    onXaiOAuthCredentialsRefreshed: input.onXaiOAuthCredentialsRefreshed,
  })
  /** 标题请求沿用 Agent 的代理与传输选择。 */
  const connection = resolvePiTitleConnectionSettings(input.proxyUrl)
  /** 请求结束后由 completePiTitleRequest 统一关闭的代理 dispatcher。 */
  const dispatcher = createPiRequestProxyDispatcher({
    proxyUrl: connection.proxyUrl,
    noProxy: connection.noProxy,
    httpIdleTimeoutMs: TITLE_REQUEST_TIMEOUT_MS,
  })

  return completePiTitleRequest(
    modelRuntime as PiTitleRuntime,
    model,
    input.prompt,
    {
      dispatcher,
      installRequestProxyFetch: installPiRequestProxyFetch,
      runWithRequestProxy: runWithPiRequestProxy,
      closeRequestProxyDispatcher: closePiRequestProxyDispatcher,
    },
    input.signal,
    connection.transport,
  )
}
