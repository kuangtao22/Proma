import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type {
  ExecuteMiniMaxImagesInput,
  MiniMaxImagesExecutorDependencies,
} from './minimax-image-executor'

/** 防止测试加载附件服务的 Electron UI 依赖。 */
mock.module('../attachment-service', () => ({
  saveAttachment: () => { throw new Error('测试必须注入 saveAttachment') },
  deleteAttachment: () => undefined,
}))

type ExecutorModule = typeof import('./minimax-image-executor')
let executeMiniMaxImages: ExecutorModule['executeMiniMaxImages']

beforeAll(async () => {
  ({ executeMiniMaxImages } = await import('./minimax-image-executor'))
})

/** 构造带可观测依赖的执行器替身。 */
function createDependencies(options: {
  status?: number
  body?: unknown
  downloadFails?: boolean
} = {}): {
  dependencies: MiniMaxImagesExecutorDependencies
  requests: { url: string; init: RequestInit | undefined }[]
  saved: string[]
  deleted: string[]
} {
  const requests: { url: string; init: RequestInit | undefined }[] = []
  const saved: string[] = []
  const deleted: string[] = []
  let sequence = 0
  return {
    requests,
    saved,
    deleted,
    dependencies: {
      fetch: async (url, init) => {
        requests.push({ url: String(url), init })
        return new Response(JSON.stringify(options.body ?? { data: { image_urls: ['https://cdn.example.com/a.png'] } }), {
          status: options.status ?? 200,
          headers: { 'content-type': 'application/json' },
        })
      },
      downloadRemoteImage: async () => {
        if (options.downloadFails) throw new Error('下载失败')
        sequence += 1
        return { bytes: Buffer.from([1, 2, 3]), mediaType: 'image/png' as const }
      },
      saveAttachment: ({ filename }) => {
        const localPath = `/tmp/${filename}`
        saved.push(localPath)
        return { attachment: { localPath, filename, mediaType: 'image/png' } } as unknown as ReturnType<MiniMaxImagesExecutorDependencies['saveAttachment']>
      },
      deleteAttachment: (path) => { deleted.push(path) },
      createId: () => `id${sequence + 1}`,
    },
  }
}

/** 构造一次带独立凭据的运行路由。 */
function createInput(overrides: Record<string, unknown> = {}): ExecuteMiniMaxImagesInput {
  return {
    route: {
      executor: 'minimax-image',
      snapshot: { profileId: 'imagegen:image-minimax:image-01', name: '我的 MiniMax · Image 01', modelId: 'image-01', executor: 'minimax-image', imageProfileId: 'image-minimax' },
      baseUrl: 'https://api.minimax.cn/v1',
      apiKey: 'sk-independent',
    },
    sessionId: 'session-1',
    prompt: '一只戴帽子的猫',
    ...overrides,
  } as ExecuteMiniMaxImagesInput
}

describe('MiniMax 图像执行器', () => {
  test('Given 文生图请求 When 执行 Then 用独立凭据调用官方端点并保存附件', async () => {
    const { dependencies, requests, saved } = createDependencies()
    const result = await executeMiniMaxImages(createInput({ aspectRatio: '16:9', numberOfImages: 2 }), dependencies)
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe('https://api.minimax.cn/v1/image_generation')
    const init = requests[0]!.init as RequestInit
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-independent')
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: 'image-01', prompt: '一只戴帽子的猫', n: 2, aspect_ratio: '16:9', response_format: 'url',
    })
    expect(result.imageAttachments).toHaveLength(1)
    expect(saved).toHaveLength(1)
  })

  test('Given 不支持的宽高比 When 执行 Then 不发送该字段', async () => {
    const { dependencies, requests } = createDependencies()
    await executeMiniMaxImages(createInput({ aspectRatio: '7:5' }), dependencies)
    expect(JSON.parse(String((requests[0]!.init as RequestInit).body))).not.toHaveProperty('aspect_ratio')
  })

  test('Given HTTP 或业务错误 When 执行 Then 给出可读错误且不泄露凭据', async () => {
    const httpError = createDependencies({ status: 401, body: { base_resp: { status_code: 1004, status_msg: 'invalid api key' } } })
    await expect(executeMiniMaxImages(createInput(), httpError.dependencies)).rejects.toThrow('MiniMax 图像接口返回 401')

    const businessError = createDependencies({ body: { base_resp: { status_code: 1002, status_msg: 'rate limit' } } })
    await expect(executeMiniMaxImages(createInput(), businessError.dependencies)).rejects.toThrow('MiniMax 图像生成失败：rate limit')
  })

  test('Given 空结果或下载失败 When 执行 Then 不留下半成品附件', async () => {
    const empty = createDependencies({ body: { data: { image_urls: [] } } })
    await expect(executeMiniMaxImages(createInput(), empty.dependencies)).rejects.toThrow('未返回任何图片')
    expect(empty.saved).toHaveLength(0)

    const failed = createDependencies({ downloadFails: true })
    await expect(executeMiniMaxImages(createInput(), failed.dependencies)).rejects.toThrow('下载失败')
    expect(failed.saved).toHaveLength(0)
  })

  test('Given 传入参考图 When 执行 Then 以 Data URL 走人物主体参考', async () => {
    const { dependencies, requests } = createDependencies()
    const workDir = mkdtempSync(join(tmpdir(), 'minimax-i2i-'))
    const referencePath = join(workDir, 'ref.png')
    writeFileSync(referencePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    await executeMiniMaxImages(createInput({ referenceImagePaths: [referencePath], cwd: workDir }), dependencies)
    const body = JSON.parse(String((requests[0]!.init as RequestInit).body))
    expect(body.subject_reference).toHaveLength(1)
    expect(body.subject_reference[0]).toMatchObject({ type: 'character' })
    /** 参考图以 Data URL 内联，不上传到第三方存储。 */
    expect(String(body.subject_reference[0].image_file)).toStartWith('data:image/png;base64,')
    rmSync(workDir, { recursive: true, force: true })
  })

  test('Given image-01 传入合法尺寸 When 执行 Then 请求体带上宽高', async () => {
    const { dependencies, requests } = createDependencies()
    await executeMiniMaxImages(createInput({ width: 1024, height: 1024 }), dependencies)
    expect(JSON.parse(String((requests[0]!.init as RequestInit).body))).toMatchObject({ width: 1024, height: 1024 })
  })

  test('Given 尺寸非法或模型不支持 When 执行 Then 在联网前拒绝', async () => {
    const { dependencies, requests } = createDependencies()
    await expect(executeMiniMaxImages(createInput({ width: 1024 }), dependencies))
      .rejects.toThrow('必须同时提供 width 与 height')
    /** image-01-live 不支持自定义宽高。 */
    const live = createInput({ width: 1024, height: 1024 })
    live.route.snapshot.modelId = 'image-01-live'
    await expect(executeMiniMaxImages(live, dependencies))
      .rejects.toThrow('仅 image-01 支持自定义宽高')
    /** 必须满足 8 的倍数与取值区间。 */
    await expect(executeMiniMaxImages(createInput({ width: 1020, height: 1024 }), dependencies))
      .rejects.toThrow('8 的倍数')
    expect(requests).toHaveLength(0)
  })

  test('Given 参考图越出授权目录 When 执行 Then 在联网前拒绝', async () => {
    const { dependencies, requests } = createDependencies()
    const workDir = mkdtempSync(join(tmpdir(), 'minimax-deny-'))
    await expect(executeMiniMaxImages(createInput({ referenceImagePaths: ['/etc/hosts'], cwd: workDir }), dependencies))
      .rejects.toThrow('参考图不在授权目录内')
    expect(requests).toHaveLength(0)
    rmSync(workDir, { recursive: true, force: true })
  })
})
