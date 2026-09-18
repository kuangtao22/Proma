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

  test('Given 传入参考图 When 执行 Then 在调用 CLI 前明确拒绝', async () => {
    const fixture = createFixture()
    await expect(executeDreaminaImages(createInput({ referenceImagePaths: ['/tmp/a.png'] }), fixture.dependencies))
      .rejects.toThrow('图生图执行器尚未接入')
    expect(fixture.calls).toHaveLength(0)
  })
})
