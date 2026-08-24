import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ResolvedImageGenerationRoute } from '../image-generation-runtime'
import type { DownloadedRemoteImage } from './safe-remote-image'
import type {
  ExecuteOpenAIImagesInput,
  OpenAIImagesExecutorDependencies,
} from './openai-images-executor'

const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')
const PNG_BASE64 = PNG_BYTES.toString('base64')
const temporaryRoots: string[] = []

/** 防止测试加载附件服务的 Electron UI 依赖。 */
mock.module('../attachment-service', () => ({
  saveAttachment: () => { throw new Error('测试必须注入 saveAttachment') },
  deleteAttachment: () => undefined,
}))

type ExecutorModule = typeof import('./openai-images-executor')
let executor: ExecutorModule

beforeAll(async () => {
  executor = await import('./openai-images-executor')
})

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

interface CapturedRequest {
  url: string
  headers: Record<string, string>
  body: BodyInit | null | undefined
}

/** 创建只存在于主进程内存的 GPT Image 2 路由。 */
function createResolvedOpenAIRoute(): Extract<ResolvedImageGenerationRoute, { executor: 'openai-images' }> {
  return {
    executor: 'openai-images',
    snapshot: {
      profileId: 'profile-gpt',
      name: 'GPT Image 2',
      executor: 'openai-images',
      channelId: 'channel-gpt',
      modelId: 'gpt-image-2',
    },
    baseUrl: 'http://100.124.186.117:8030/v1',
    apiKey: 'secret-key',
  }
}

/** 创建默认文生图输入。 */
function createExecutionInput(): ExecuteOpenAIImagesInput {
  return {
    route: createResolvedOpenAIRoute(),
    sessionId: 'session-1',
    prompt: 'Create a product poster',
    aspectRatio: '1:1',
    numberOfImages: 1,
  }
}

/** 创建一张位于授权根目录内的 PNG 参考图。 */
function createReferenceImageFixture(): { root: string; imagePath: string } {
  const root = mkdtempSync(join(tmpdir(), 'proma-openai-images-'))
  temporaryRoots.push(root)
  const imagePath = join(root, 'reference.png')
  writeFileSync(imagePath, PNG_BYTES)
  return { root, imagePath }
}

/** 创建捕获请求且不产生真实附件副作用的执行器依赖。 */
function createExecutorDependencies(
  requests: CapturedRequest[],
  responseBody: Record<string, unknown>,
  onFetch?: () => void,
  downloadRemoteImage: OpenAIImagesExecutorDependencies['downloadRemoteImage'] = async (): Promise<DownloadedRemoteImage> => ({
    bytes: PNG_BYTES,
    mediaType: 'image/png',
  }),
): OpenAIImagesExecutorDependencies {
  return {
    fetch: async (input, init) => {
      onFetch?.()
      requests.push({
        url: String(input),
        headers: Object.fromEntries(new Headers(init?.headers).entries()),
        body: init?.body,
      })
      return new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
    downloadRemoteImage,
    saveAttachment: ({ conversationId, filename, mediaType }) => ({
      attachment: {
        id: 'attachment-1',
        filename,
        mediaType,
        localPath: `${conversationId}/saved.png`,
        size: PNG_BYTES.length,
      },
    }),
    deleteAttachment: () => undefined,
    createId: () => 'fixed-id',
  }
}

describe('OpenAI Images executor', () => {
  test('Given 无参考图 When 调用 GPT Image 2 Then 发送 Bearer JSON generations 请求', async () => {
    const requests: CapturedRequest[] = []
    const result = await executor.executeOpenAIImages(
      createExecutionInput(),
      createExecutorDependencies(requests, { data: [{ b64_json: PNG_BASE64 }] }),
    )

    expect(requests[0]).toMatchObject({
      url: 'http://100.124.186.117:8030/v1/images/generations',
      headers: { authorization: 'Bearer secret-key', 'content-type': 'application/json' },
    })
    expect(JSON.parse(String(requests[0]?.body))).toEqual({
      model: 'gpt-image-2',
      prompt: 'Create a product poster',
      size: '1024x1024',
      n: 1,
    })
    expect(result.imageAttachments).toHaveLength(1)
  })

  test('Given 一张授权参考图 When 调用 Then 发送 multipart edits 请求', async () => {
    const fixture = createReferenceImageFixture()
    const requests: CapturedRequest[] = []
    await executor.executeOpenAIImages({
      route: createResolvedOpenAIRoute(),
      sessionId: 'session-1',
      prompt: 'Change the background',
      referenceImagePaths: [fixture.imagePath],
      cwd: fixture.root,
    }, createExecutorDependencies(requests, { data: [{ image_base64: PNG_BASE64 }] }))

    expect(requests[0]?.url).toEndWith('/images/edits')
    expect(requests[0]?.body).toBeInstanceOf(FormData)
    expect((requests[0]?.body as FormData).get('model')).toBe('gpt-image-2')
    expect((requests[0]?.body as FormData).get('image')).toBeInstanceOf(Blob)
  })

  test('Given 越界参考图 When 调用 Then 在 fetch 前拒绝', async () => {
    let fetched = false
    await expect(executor.executeOpenAIImages({
      route: createResolvedOpenAIRoute(),
      sessionId: 'session-1',
      prompt: 'Edit',
      referenceImagePaths: ['/private/outside.png'],
      cwd: '/workspace/allowed',
    }, createExecutorDependencies([], {}, () => { fetched = true })))
      .rejects.toThrow('参考图不在授权目录内')
    expect(fetched).toBe(false)
  })

  test.each(['b64_json', 'image_base64', 'base64'] as const)(
    'Given %s 响应 When 解析 Then 保存本地结构化附件',
    async (field) => {
      const result = await executor.executeOpenAIImages(
        createExecutionInput(),
        createExecutorDependencies([], { data: [{ [field]: PNG_BASE64 }] }),
      )
      expect(result.imageAttachments[0]).toEqual(expect.objectContaining({
        filename: expect.stringMatching(/^gpt-image-2-/),
        mediaType: 'image/png',
      }))
    },
  )

  test.each(['url', 'image_url'] as const)(
    'Given %s 响应 When 解析 Then 通过安全下载后保存',
    async (field) => {
      /** 记录传给安全下载器的 URL。 */
      const downloaded: string[] = []
      const result = await executor.executeOpenAIImages(
        createExecutionInput(),
        createExecutorDependencies([], {
          data: [{ [field]: 'https://images.example/result.png' }],
        }, undefined, async (url) => {
          downloaded.push(url)
          return { bytes: PNG_BYTES, mediaType: 'image/png' }
        }),
      )
      expect(downloaded).toEqual(['https://images.example/result.png'])
      expect(result.imageAttachments).toHaveLength(1)
    },
  )

  test('Given 第二个附件保存失败 When 执行 Then 删除第一个已保存附件', async () => {
    /** 记录失败回滚删除的本地附件路径。 */
    const deleted: string[] = []
    const dependencies = createExecutorDependencies([], {
      data: [{ b64_json: PNG_BASE64 }, { b64_json: PNG_BASE64 }],
    })
    let saveCount = 0
    dependencies.saveAttachment = (input) => {
      saveCount += 1
      if (saveCount === 2) throw new Error('保存失败')
      return {
        attachment: {
          id: 'attachment-1',
          filename: input.filename,
          mediaType: input.mediaType,
          localPath: 'session-1/first.png',
          size: PNG_BYTES.length,
        },
      }
    }
    dependencies.deleteAttachment = (path) => { deleted.push(path) }

    await expect(executor.executeOpenAIImages(createExecutionInput(), dependencies)).rejects.toThrow('保存失败')
    expect(deleted).toEqual(['session-1/first.png'])
  })
})
