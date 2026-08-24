/**
 * Nano Banana MCP Server（Agent 模式）
 *
 * 基于 Gemini Image Generation API 的内置 MCP 服务器。
 * 通过 Pi custom tool 注入到启用 Nano Banana 的 Agent 会话。
 * 支持文生图、多轮连续修改。凭据复用 chat-tools.json 配置。
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { extname, resolve, isAbsolute, join, relative } from 'node:path'
import { getToolState, getToolCredentials } from '../chat-tool-config'
import { Type } from 'typebox'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { AgentToolResult } from '@earendil-works/pi-agent-core'
import type { AgentToolResultImage, ImageGenerationModelSnapshot } from '@proma/shared'
import { saveAttachment, isImageAttachment } from '../attachment-service'
import type { ResolveImageGenerationRoute } from '../image-generation-runtime'
import { executeOpenAIImages } from './openai-images-executor'

// ===== Gemini API 类型（REST API 使用 camelCase） =====

interface GeminiInlineData {
  mimeType: string
  data: string
}

interface GeminiPart {
  text?: string
  inlineData?: GeminiInlineData
  /** Gemini 多轮对话必需：模型生成图片时附带的签名，回传时原样保留 */
  thoughtSignature?: string
  /** snake_case 兼容（部分 API 版本） */
  thought_signature?: string
  /** Flash 思考模式下的 reasoning part，不应作为输出图展示 */
  thought?: boolean
}

interface GeminiContent {
  role: 'user' | 'model'
  parts: GeminiPart[]
}

interface GeminiCandidate {
  content: {
    parts: GeminiPart[]
    role: string
  }
}

interface GeminiResponse {
  candidates?: GeminiCandidate[]
  error?: { message: string; code: number }
}

// ===== 多轮对话历史（按 sessionId 隔离） =====

const sessionHistory = new Map<string, GeminiContent[]>()

// ===== 默认配置 =====

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com'
const DEFAULT_MODEL = 'gemini-3.1-flash-image-preview'
/** Design 可信路由缺少主进程实时解析时使用的稳定拒绝原因。 */
const MISSING_TRUSTED_ROUTE_RESOLVER_ERROR = '设计任务缺少可信生图模型实时解析，已拒绝执行'

// ===== MCP 内容块类型 =====

interface McpTextContent {
  type: 'text'
  text: string
  [key: string]: unknown
}

interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
  [key: string]: unknown
}

type McpContent = McpTextContent | McpImageContent

interface McpToolResult {
  content: McpContent[]
  /** 仅由本地主进程保存流程产生，不从 Gemini 文本反解析。 */
  imageAttachments?: AgentToolResultImage[]
  [key: string]: unknown
}

/** Pi transcript 中用于证明 Nano Banana 本地附件来源的结构化详情。 */
interface NanoBananaToolResultDetails {
  source: 'proma-nano-banana'
  toolUseId: string
  generated: boolean
  imageAttachments: AgentToolResultImage[]
}

// ===== Gemini API 调用 =====

/** 已知图片扩展名 → MIME 类型映射 */
const EXT_TO_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
}

/**
 * 从文件路径列表读取参考图，转换为 GeminiPart[]
 *
 * 支持绝对路径和相对路径（相对于 cwd 解析）。
 * 跳过不存在、非图片、读取失败的文件。
 */
function readReferenceImages(paths: string[], cwd?: string, allowedRoots: string[] = []): GeminiPart[] {
  const roots = [cwd, ...allowedRoots]
    .filter((root): root is string => typeof root === 'string' && root.length > 0)
    .map((root) => {
      const resolved = resolve(root)
      try { return realpathSync(resolved) } catch { return resolved }
    })
  const parts: GeminiPart[] = []
  for (const rawPath of paths) {
    try {
      const requestedPath = isAbsolute(rawPath) ? rawPath : resolve(cwd ?? process.cwd(), rawPath)
      if (!existsSync(requestedPath)) {
        console.warn(`[Nano Banana MCP] 参考图不存在: ${requestedPath}`)
        continue
      }
      // Resolve symlinks before checking containment; an attached symlink must not escape
      // the directories explicitly authorized for this Agent run.
      const filePath = realpathSync(requestedPath)
      const authorized = roots.some((root) => {
        const rel = relative(root, filePath)
        return rel === '' || (!rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && rel !== '..' && !isAbsolute(rel))
      })
      if (!authorized) {
        console.warn(`[Nano Banana MCP] 拒绝读取授权目录外的参考图: ${filePath}`)
        continue
      }
      const ext = extname(filePath).toLowerCase()
      const mimeType = EXT_TO_MIME[ext]
      if (!mimeType || !isImageAttachment(mimeType)) {
        console.warn(`[Nano Banana MCP] 非图片文件，跳过: ${filePath}`)
        continue
      }
      const data = readFileSync(filePath).toString('base64')
      parts.push({ inlineData: { mimeType, data } })
    } catch (error) {
      console.warn(`[Nano Banana MCP] 读取参考图失败: ${rawPath}`, error)
    }
  }
  return parts
}

/**
 * Gemini 多轮对话中，模型响应包含 thoughtSignature 后，
 * 后续所有 user 消息的 text part 也必须携带 thoughtSignature。
 * 使用 Gemini 官方提供的跳过验证占位符。
 * @see https://ai.google.dev/gemini-api/docs/thought-signatures
 */
const DUMMY_THOUGHT_SIGNATURE = 'skip_thought_signature_validator'

/** 检查对话历史中是否存在 thoughtSignature */
function historyHasThoughtSignature(history: GeminiContent[]): boolean {
  return history.some((c) =>
    c.parts.some((p) => p.thoughtSignature || p.thought_signature),
  )
}

/**
 * 构建 Gemini API 请求体
 */
function buildGeminiRequest(
  prompt: string,
  referenceImageParts: GeminiPart[],
  history: GeminiContent[],
  options: { aspectRatio?: string; imageSize?: string; numberOfImages?: number },
): Record<string, unknown> {
  // 多轮对话中 model 响应含 thoughtSignature 时，新 user 的 text part 也必须带签名
  const needsSignature = history.length > 0 && historyHasThoughtSignature(history)

  const userParts: GeminiPart[] = [
    ...referenceImageParts,
    {
      text: prompt,
      ...(needsSignature && { thoughtSignature: DUMMY_THOUGHT_SIGNATURE }),
    },
  ]

  const contents: GeminiContent[] = [
    ...history,
    { role: 'user', parts: userParts },
  ]

  const generationConfig: Record<string, unknown> = {
    responseModalities: ['TEXT', 'IMAGE'],
  }

  const imageConfig: Record<string, unknown> = {}
  if (options.aspectRatio && options.aspectRatio !== '1:1') {
    imageConfig.aspectRatio = options.aspectRatio
  }
  if (options.imageSize && options.imageSize !== 'auto') {
    imageConfig.imageSize = options.imageSize
  }
  // NOTE: numberOfImages is kept in schema for future API support but not forwarded.
  if (Object.keys(imageConfig).length > 0) {
    generationConfig.imageConfig = imageConfig
  }

  return { contents, generationConfig }
}

/**
 * 调用 Gemini Image Generation API 并返回 MCP 工具结果
 */
async function callGeminiAndBuildResult(
  prompt: string,
  sessionId: string,
  options: {
    aspectRatio?: string
    imageSize?: string
    referenceImagePaths?: string[]
    cwd?: string
    allowedRoots?: string[]
    numberOfImages?: number
    trustedImageRoute?: ImageGenerationModelSnapshot
  },
  signal?: AbortSignal,
): Promise<McpToolResult> {
  signal?.throwIfAborted()
  const credentials = getToolCredentials('nano-banana')
  if (!credentials.apiKey?.trim()) throw new Error('Nano Banana API Key 未配置: nano-banana')
  const baseUrl = credentials.baseUrl?.trim() || DEFAULT_BASE_URL
  const model = options.trustedImageRoute?.modelId
    ?? (credentials.model?.trim() || DEFAULT_MODEL)

  // 获取会话历史
  const history = sessionHistory.get(sessionId) ?? []

  // 读取参考图
  const referenceImageParts = options.referenceImagePaths?.length
    ? readReferenceImages(options.referenceImagePaths, options.cwd, options.allowedRoots)
    : []
  signal?.throwIfAborted()
  if (referenceImageParts.length > 0) {
    console.log(`[Nano Banana MCP] 加载了 ${referenceImageParts.length} 张参考图`)
  }

  // 构建请求
  const requestBody = buildGeminiRequest(prompt, referenceImageParts, history, {
    aspectRatio: options.aspectRatio,
    imageSize: options.imageSize,
    numberOfImages: options.numberOfImages,
  })
  const url = `${baseUrl}/v1beta/models/${model}:generateContent?key=${credentials.apiKey}`

  console.log(`[Nano Banana MCP] 调用 Gemini API: model=${model}, prompt="${prompt.slice(0, 50)}..."`)

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    signal,
  })
  signal?.throwIfAborted()

  if (!response.ok) {
    const errorText = await response.text()
    console.error(`[Nano Banana MCP] API 请求失败 (${response.status}):`, errorText)
    return {
      content: [{ type: 'text' as const, text: `Gemini API 请求失败 (${response.status}): ${errorText.slice(0, 200)}` }],
    }
  }

  const data = (await response.json()) as GeminiResponse
  signal?.throwIfAborted()

  if (data.error) {
    return {
      content: [{ type: 'text' as const, text: `Gemini API 错误: ${data.error.message}` }],
    }
  }

  if (!data.candidates || data.candidates.length === 0) {
    return {
      content: [{ type: 'text' as const, text: '未生成任何内容' }],
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- candidates[0] 已通过上方 length 检查
  const parts = data.candidates![0]!.content.parts
  console.log(`[Nano Banana MCP] 响应包含 ${parts.length} 个 parts，类型:`,
    parts.map((p) => p.inlineData ? `image(${p.inlineData.mimeType})` : `text(${(p.text ?? '').slice(0, 30)})`))

  const mcpContent: McpContent[] = []
  const textParts: string[] = []
  const savedWorkspacePaths: string[] = []
  const imageAttachments: AgentToolResultImage[] = []

  // 解析响应：提取图片和文本（跳过 thought parts，它们是推理过程图，不作为输出）
  for (const part of parts) {
    signal?.throwIfAborted()
    if (part.thought) continue
    if (part.inlineData) {
      // 保存图片到附件目录（供 UI 渲染）
      const ext = part.inlineData.mimeType === 'image/jpeg' ? '.jpg' : '.png'
      const filename = `nano-banana-${randomUUID().slice(0, 8)}${ext}`
      const result = saveAttachment({
        conversationId: sessionId,
        filename,
        mediaType: part.inlineData.mimeType,
        data: part.inlineData.data,
      })

      // 同时保存到 Agent 工作 session 目录（供 Agent 直接引用）
      if (options.cwd) {
        try {
          const imgDir = join(options.cwd, 'generated-images')
          mkdirSync(imgDir, { recursive: true })
          const workspacePath = join(imgDir, filename)
          writeFileSync(workspacePath, Buffer.from(part.inlineData.data, 'base64'))
          savedWorkspacePaths.push(workspacePath)
        } catch (err) {
          console.warn(`[Nano Banana MCP] 保存图片到工作目录失败:`, err)
        }
      }

      // MCP image content block（供 SDK/模型查看）
      mcpContent.push({
        type: 'image' as const,
        data: part.inlineData.data,
        mimeType: part.inlineData.mimeType,
      })

      /** 本地保存结果走结构化通道，Gemini 返回文本无法伪造该字段。 */
      imageAttachments.push({
        localPath: result.attachment.localPath,
        filename: result.attachment.filename,
        mediaType: result.attachment.mediaType,
      })
    } else if (part.text) {
      textParts.push(part.text)
    }
  }

  // 更新会话历史（保留原始 parts 含 thoughtSignature，多轮编辑必需）
  const userContent: GeminiContent = { role: 'user', parts: [...referenceImageParts, { text: prompt }] }
  const modelContent: GeminiContent = { role: 'model', parts }
  const updatedHistory = [...history, userContent, modelContent]
  signal?.throwIfAborted()
  sessionHistory.set(sessionId, updatedHistory)

  // 在图片内容块之后追加文本摘要
  const imageCount = mcpContent.filter((c) => c.type === 'image').length
  const pathInfo = savedWorkspacePaths.length > 0
    ? `\n图片已保存到工作目录:\n${savedWorkspacePaths.map((p) => `- ${p}`).join('\n')}`
    : ''
  const summaryText = imageCount > 0
    ? `图片已生成（${imageCount} 张）${pathInfo}\n${textParts.join('\n')}`
    : textParts.join('\n') || '未生成图片内容'

  mcpContent.push({ type: 'text' as const, text: summaryText })

  return { content: mcpContent, imageAttachments }
}

// ===== Pi 工具注入 =====

type PiSdk = typeof import('@earendil-works/pi-coding-agent')

export interface PiNanoBananaToolsContext {
  sessionId: string
  agentCwd?: string
  allowedRoots?: string[]
  /** Design Job 固化的可信模型，优先级高于全局凭据模型。 */
  trustedImageRoute?: ImageGenerationModelSnapshot
  /** 每次图片工具执行前实时解析可信模型与主进程凭据。 */
  resolveTrustedImageRoute?: ResolveImageGenerationRoute
  /** Design 可信图片工具在任何文件或网络副作用前回传真实结构化参数。 */
  captureDesignImageCall?: (input: { designSummary: string; prompt: string }) => void
}

function toPiToolResult(result: McpToolResult, toolUseId: string): AgentToolResult<NanoBananaToolResultDetails> {
  // 图片已在生成时保存为 Proma attachment。Pi 的普通 tool result 保持文本形态，
  // 本地附件通过 details 单独传递，避免把 Gemini base64 图片重复写入 transcript。
  const text = result.content
    .filter((item): item is McpTextContent => item.type === 'text')
    .map((item) => item.text)
    .join('\n')
  return {
    content: [{ type: 'text', text: text || '图片已生成。' }],
    details: {
      source: 'proma-nano-banana',
      toolUseId,
      generated: (result.imageAttachments?.length ?? 0) > 0,
      imageAttachments: result.imageAttachments ?? [],
    },
  }
}

/**
 * 构建 Pi custom tool。会话历史仍按 Proma sessionId 隔离，因此连续编辑与 Claude
 * runtime 时代保持相同行为；参考图只从用户已授权的工作目录读取。
 */
export function buildPiNanoBananaTools(
  sdk: PiSdk,
  ctx: PiNanoBananaToolsContext,
): ToolDefinition[] {
  if (!ctx.trustedImageRoute) {
    const toolState = getToolState('nano-banana')
    const credentials = getToolCredentials('nano-banana')
    if (!toolState.enabled || !credentials.apiKey) return []
  }

  /** 可信 Design 路由额外要求中文设计摘要；普通 Agent 继续沿用原参数合同。 */
  const parameters = ctx.trustedImageRoute
    ? Type.Object({
        designSummary: Type.String({ minLength: 1, maxLength: 4000, description: '用中文概括本次视觉判断和关键设计决策。' }),
        prompt: Type.String({ minLength: 1, maxLength: 16000, description: '图片模型可直接执行的精确提示词。' }),
        referenceImagePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute or cwd-relative reference image path.' }))),
        aspectRatio: Type.Optional(Type.Union([Type.Literal('1:1'), Type.Literal('16:9'), Type.Literal('4:3'), Type.Literal('9:16'), Type.Literal('3:4')])),
        imageSize: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K')])),
        numberOfImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      })
    : Type.Object({
        prompt: Type.String({ description: 'Detailed description of the image to generate or edit. English descriptions work best.' }),
        referenceImagePaths: Type.Optional(Type.Array(Type.String({ description: 'Absolute or cwd-relative reference image path.' }))),
        aspectRatio: Type.Optional(Type.Union([Type.Literal('1:1'), Type.Literal('16:9'), Type.Literal('4:3'), Type.Literal('9:16'), Type.Literal('3:4')])),
        imageSize: Type.Optional(Type.Union([Type.Literal('auto'), Type.Literal('1K'), Type.Literal('2K'), Type.Literal('4K')])),
        numberOfImages: Type.Optional(Type.Integer({ minimum: 1, maximum: 4 })),
      })

  return [sdk.defineTool({
    name: 'mcp__nano_banana__generate_image',
    label: '生成或编辑图片',
    description: 'Generate or edit images using Gemini Image Generation. Supports text-to-image, reference image editing, and iterative multi-turn editing. Use English prompts for best results. Previous generations are automatically used as context. When the user uploads images (listed in <attached_files>) or mentions image files via @file:{path}, pass their paths through referenceImagePaths.',
    promptSnippet: 'Nano Banana: generate or edit images. Pass user-authorized reference image paths when editing an existing image.',
    parameters,
    async execute(toolCallId, args, signal) {
      try {
        /** 可信路由解析必须早于历史、文件或网络副作用。 */
        const resolvedRoute = ctx.trustedImageRoute
          ? ctx.resolveTrustedImageRoute?.(ctx.trustedImageRoute)
          : undefined
        if (ctx.trustedImageRoute && !resolvedRoute) throw new Error(MISSING_TRUSTED_ROUTE_RESOLVER_ERROR)
        /** 直调 execute 的测试和适配层也必须经过可信参数运行时校验。 */
        const prompt = typeof args.prompt === 'string' ? args.prompt : ''
        if (ctx.trustedImageRoute) {
          const designSummary = 'designSummary' in args && typeof args.designSummary === 'string'
            ? args.designSummary
            : ''
          if (!designSummary.trim() || designSummary.length > 4000) {
            throw new Error('Design 图片工具参数 designSummary 必须为 1-4000 字符')
          }
          if (!prompt.trim() || prompt.length > 16000) {
            throw new Error('Design 图片工具参数 prompt 必须为 1-16000 字符')
          }
          ctx.captureDesignImageCall?.({ designSummary, prompt })
        }
        const referenceImagePaths = Array.isArray(args.referenceImagePaths)
          ? args.referenceImagePaths.filter((path): path is string => typeof path === 'string')
          : undefined
        const result: McpToolResult = resolvedRoute?.executor === 'openai-images'
          ? {
              content: [{ type: 'text', text: referenceImagePaths && referenceImagePaths.length > 1
                ? '图片已生成。当前协议使用第一张参考图。'
                : '图片已生成。' }],
              imageAttachments: (await executeOpenAIImages({
                route: resolvedRoute,
                sessionId: ctx.sessionId,
                prompt,
                referenceImagePaths,
                cwd: ctx.agentCwd,
                allowedRoots: ctx.allowedRoots,
                aspectRatio: typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined,
                imageSize: typeof args.imageSize === 'string' ? args.imageSize : undefined,
                numberOfImages: typeof args.numberOfImages === 'number' ? args.numberOfImages : undefined,
                signal,
              })).imageAttachments,
            }
          : await callGeminiAndBuildResult(prompt, ctx.sessionId, {
              aspectRatio: typeof args.aspectRatio === 'string' ? args.aspectRatio : undefined,
              imageSize: typeof args.imageSize === 'string' ? args.imageSize : undefined,
              referenceImagePaths,
              cwd: ctx.agentCwd,
              allowedRoots: ctx.allowedRoots,
              numberOfImages: typeof args.numberOfImages === 'number' ? args.numberOfImages : undefined,
              trustedImageRoute: ctx.trustedImageRoute,
            }, signal)
        return toPiToolResult(result, toolCallId)
      } catch (error) {
        if (signal?.aborted) signal.throwIfAborted()
        if (error instanceof Error && error.name === 'AbortError') throw error
        const message = error instanceof Error ? error.message : String(error)
        console.error('[Nano Banana Pi 工具] 执行失败:', error)
        return {
          content: [{ type: 'text', text: `图片生成失败: ${message}` }],
          details: { generated: false },
        } as AgentToolResult<unknown>
      }
    },
  })]
}

// ===== 清理 =====

/**
 * 清除 Agent 会话的生图历史（会话删除时调用）
 */
export function clearNanoBananaAgentHistory(sessionId: string): void {
  sessionHistory.delete(sessionId)
}
