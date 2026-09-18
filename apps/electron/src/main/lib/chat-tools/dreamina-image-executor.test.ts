import { beforeAll, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecuteDreaminaImagesInput, DreaminaImagesExecutorDependencies } from './dreamina-image-executor'

/** 防止测试加载附件服务的 Electron UI 依赖。 */
mock.module('../attachment-service', () => ({
  saveAttachment: () => { throw new Error('测试必须注入 saveAttachment') },
  deleteAttachment: () => undefined,
}))

type ExecutorModule = typeof import('./dreamina-image-executor')
let executeDreaminaImages: ExecutorModule['executeDreaminaImages']

beforeAll(async () => {
  ({ executeDreaminaImages } = await import('./dreamina-image-executor'))
})

interface Fixture {
  dependencies: DreaminaImagesExecutorDependencies
  calls: readonly string[][]
  saved: string[]
  removed: string[]
}

/** 构造确定性 CLI 与临时目录；所有生成结果都在受控目录里。 */
function createFixture(options: {
  statuses?: string[]
  failReason?: string
  failureCode?: 'cliMissing' | 'timeout'
  compliance?: boolean
  pathOutside?: boolean
  pathMissing?: boolean
  cliFails?: boolean
} = {}): Fixture {
  const calls: string[][] = []
  const saved: string[] = []
  const removed: string[] = []
  const workDir = mkdtempSync(join(tmpdir(), 'dreamina-exec-'))
  const imagePath = join(workDir, 'result-1.png')
  if (!options.pathMissing) writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  const statuses = [...(options.statuses ?? ['success'])]
  return {
    calls,
    saved,
    removed,
    dependencies: {
      runCli: async (args) => {
        calls.push([...args])
        if (options.failureCode) return { exitCode: 1, stdout: '', stderr: '', failureCode: options.failureCode }
        if (args[0] === 'text2image') {
          const stdout = options.compliance ? 'AigcComplianceConfirmationRequired' : JSON.stringify({ submit_id: 'submit-1', gen_status: 'querying' })
          return { exitCode: options.cliFails ? 1 : 0, stdout, stderr: '' }
        }
        const status = statuses.length > 1 ? statuses.shift()! : statuses[0]!
        return {
          exitCode: status === 'fail' ? 1 : 0,
          stdout: JSON.stringify({
            submit_id: 'submit-1',
            gen_status: status,
            fail_reason: options.failReason ?? '',
            result_json: { images: status === 'success' ? [{ path: options.pathOutside ? '/etc/hosts' : imagePath }] : [] },
          }),
          stderr: '',
        }
      },
      saveAttachment: ({ filename }) => {
        const localPath = `/managed/${filename}`
        saved.push(localPath)
        return { attachment: { localPath, filename, mediaType: 'image/png' } } as unknown as ReturnType<DreaminaImagesExecutorDependencies['saveAttachment']>
      },
      deleteAttachment: () => undefined,
      createTempDir: async () => workDir,
      removeTempDir: async (path) => { removed.push(path); rmSync(path, { recursive: true, force: true }) },
    },
  }
}

/** 构造一次即梦运行路由。 */
function createInput(overrides: Partial<ExecuteDreaminaImagesInput> = {}): ExecuteDreaminaImagesInput {
  return {
    route: {
      executor: 'dreamina-image',
      snapshot: { profileId: 'imagegen:image-jimeng:5.0', name: '即梦 · 5.0', modelId: '5.0', executor: 'dreamina-image', imageProfileId: 'image-jimeng' },
    },
    sessionId: 'session-1',
    prompt: '一只戴帽子的猫',
    pollIntervalMs: 1,
    timeoutMs: 500,
    ...overrides,
  }
}

describe('即梦图像执行器', () => {
  test('Given 提交成功并经过轮询 When 执行 Then 下载结果并保存受管附件', async () => {
    const fixture = createFixture({ statuses: ['querying', 'success'] })
    const result = await executeDreaminaImages(createInput({ aspectRatio: '16:9', numberOfImages: 2 }), fixture.dependencies)
    expect(fixture.calls[0]![0]).toBe('text2image')
    expect(fixture.calls[0]).toContain('--model_version=5.0')
    expect(fixture.calls[0]).toContain('--generate_num=2')
    expect(fixture.calls[0]).toContain('--ratio=16:9')
    /** 提交与查询是两步，submit 被接受不等于生成完成。 */
    expect(fixture.calls[1]![0]).toBe('query_result')
    expect(fixture.calls[1]![1]).toBe('--submit_id=submit-1')
    expect(result.imageAttachments).toHaveLength(1)
    expect(fixture.saved).toHaveLength(1)
    /** 临时下载目录必须清理。 */
    expect(fixture.removed).toHaveLength(1)
  })

  test('Given 生成失败 When 执行 Then 直接报出 fail_reason 且不保存文件', async () => {
    const fixture = createFixture({ statuses: ['fail'], failReason: '内容安全审核未通过' })
    await expect(executeDreaminaImages(createInput(), fixture.dependencies)).rejects.toThrow('内容安全审核未通过')
    expect(fixture.saved).toHaveLength(0)
  })

  test('Given CLI 缺失或需要网页确认 When 执行 Then 给出可操作提示', async () => {
    const missing = createFixture({ failureCode: 'cliMissing' })
    await expect(executeDreaminaImages(createInput(), missing.dependencies)).rejects.toThrow('未找到即梦 CLI')

    const compliance = createFixture({ compliance: true })
    await expect(executeDreaminaImages(createInput(), compliance.dependencies)).rejects.toThrow('即梦网页端完成一次生成确认')
  })

  test('Given 结果路径越界或文件缺失 When 执行 Then 拒绝读取', async () => {
    const outside = createFixture({ pathOutside: true })
    await expect(executeDreaminaImages(createInput(), outside.dependencies)).rejects.toThrow('不在任务目录内')
    expect(outside.saved).toHaveLength(0)

    const missingFile = createFixture({ pathMissing: true })
    await expect(executeDreaminaImages(createInput(), missingFile.dependencies)).rejects.toThrow('图片文件不存在')
  })

  test('Given 传入参考图 When 执行 Then 改走 image2image 并上传本地图片', async () => {
    const fixture = createFixture()
    const workDir = mkdtempSync(join(tmpdir(), 'dreamina-i2i-'))
    const referencePath = join(workDir, 'ref.png')
    writeFileSync(referencePath, Buffer.from('89504e470d0a1a0a', 'hex'))
    await executeDreaminaImages(createInput({ referenceImagePaths: [referencePath], cwd: workDir }), fixture.dependencies)
    expect(fixture.calls[0]![0]).toBe('image2image')
    /** 授权校验会解析真实路径（macOS 的 /var 是 /private/var 的软链），因此只断言文件名。 */
    const imagesArg = fixture.calls[0]!.find((arg) => arg.startsWith('--images='))
    expect(imagesArg).toBeDefined()
    expect(imagesArg!.endsWith('ref.png')).toBe(true)
    rmSync(workDir, { recursive: true, force: true })
  })

  test('Given 参考图越出授权目录 When 执行 Then 在调用 CLI 前拒绝', async () => {
    const fixture = createFixture()
    const workDir = mkdtempSync(join(tmpdir(), 'dreamina-deny-'))
    await expect(executeDreaminaImages(createInput({ referenceImagePaths: ['/etc/hosts'], cwd: workDir }), fixture.dependencies))
      .rejects.toThrow('参考图不在授权目录内')
    expect(fixture.calls).toHaveLength(0)
    rmSync(workDir, { recursive: true, force: true })
  })

  test('Given 自定义尺寸 When 执行 Then 传 --width/--height 且不再传 --ratio', async () => {
    const fixture = createFixture()
    await executeDreaminaImages(createInput({ width: 1024, height: 1536, aspectRatio: '16:9' }), fixture.dependencies)
    expect(fixture.calls[0]).toContain('--width=1024')
    expect(fixture.calls[0]).toContain('--height=1536')
    /** 尺寸与宽高比互斥，CLI 会拒绝同时传入。 */
    expect(fixture.calls[0]!.some((arg) => arg.startsWith('--ratio='))).toBe(false)
  })

  test('Given 尺寸非法 When 执行 Then 在调用 CLI 前按档位限制拒绝', async () => {
    const fixture = createFixture()
    const only = createInput({ width: 1024 })
    await expect(executeDreaminaImages(only, fixture.dependencies)).rejects.toThrow('必须同时提供 width 与 height')

    /** 2k 档位每边需在 768-3072，总像素不超过 4194304。 */
    const tooSmall = createInput({ width: 512, height: 512 })
    await expect(executeDreaminaImages(tooSmall, fixture.dependencies)).rejects.toThrow('超出 2k 档位限制')

    const tooManyPixels = createInput({ width: 3072, height: 2048 })
    await expect(executeDreaminaImages(tooManyPixels, fixture.dependencies)).rejects.toThrow('超出 2k 档位限制')
    expect(fixture.calls).toHaveLength(0)
  })
})
