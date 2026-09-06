import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { CanvasDocument, CanvasTextArtifactTarget } from '@proma/shared'
import {
  createCanvasArtifactExportService,
  type CanvasArtifactExportReceiptStore,
  type CanvasArtifactExportRequest,
} from './canvas-artifact-export-service'
import type { StableDirectoryOpenedRoot } from '../stable-directory-native-host'

/** 每个场景独占的临时根，避免路径安全测试相互污染。 */
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建包含三类产物节点的权威 Canvas 文档。 */
function createDocument(): CanvasDocument {
  return {
    schemaVersion: 4,
    projectId: 'project-1',
    canvasId: 'canvas-1',
    revision: 9,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'image-1', kind: 'image', title: '封面', position: { x: 0, y: 0 }, imageModuleId: 'module-1', adoptedAssetId: 'asset-current' },
      { id: 'document-1', kind: 'document', title: '需求', position: { x: 320, y: 0 }, documentId: 'document-content-1', contentRevision: 5 },
      { id: 'webview-1', kind: 'webview', title: '页面', position: { x: 640, y: 0 }, prototypeId: 'prototype-1', contentRevision: 7, devicePreset: 'desktop' },
    ],
    edges: [],
    createdAt: 1,
    updatedAt: 2,
  }
}

/** 创建可观察精确版本与写入目标的导出服务夹具。 */
function createFixture(options: {
  choosePath?: string | undefined
  chooseDirectory?: string | undefined
  receipts?: CanvasArtifactExportReceiptStore
  onChoosePath?: () => Promise<string | undefined>
  onNativeWrite?: () => void
} = {}) {
  const projectRoot = realpathSync(mkdtempSync(join(tmpdir(), 'proma-canvas-export-project-')))
  temporaryRoots.push(projectRoot)
  const document = createDocument()
  const sourcePath = join(projectRoot, 'asset-history.png')
  writeFileSync(sourcePath, 'image:asset-history')
  const sourceBytes = readFileSync(sourcePath)
  const imageExports: Array<{ assetId: string; targetPath: string }> = []
  const textExports: Array<CanvasTextArtifactTarget & { targetPath: string; overwrite: boolean }> = []
  let validateAccessCalls = 0
  let choosePathCalls = 0
  let chooseDirectoryCalls = 0
  const service = createCanvasArtifactExportService({
    documents: { load: () => ({ document, writable: true, nodeIssues: [] }) },
    jobs: {
      getProjectJob: (_projectId, jobId) => ({
        id: jobId, creativeTaskId: 'task-1', attemptNumber: 1, projectId: 'project-1',
        target: { kind: 'canvas-image', canvasId: 'canvas-1', nodeId: 'image-1', imageModuleId: 'module-1' },
        action: 'generate', status: 'succeeded', prompt: '图片', originalRequest: '图片', contextMode: 'auto',
        outputAssetId: jobId === 'job-history' ? 'asset-history' : 'asset-current', createdAt: 1, updatedAt: 2,
      }),
    },
    assets: {
      getAsset: (_projectId, assetId) => ({
        id: assetId,
        filename: `${assetId}.png`,
        relativePath: `assets/${assetId}.png`,
        thumbnailRelativePath: `thumbnails/${assetId}.png`,
        mediaType: 'image/png',
        width: 100,
        height: 100,
        byteSize: assetId === 'asset-history' ? sourceBytes.byteLength : 10,
        sha256: assetId === 'asset-history'
          ? createHash('sha256').update(sourceBytes).digest('hex')
          : 'a'.repeat(64),
        sourceKind: 'job',
        sourceJobId: assetId === 'asset-history' ? 'job-history' : 'job-current',
        createdAt: 1,
      }),
      resolveAssetPath: (_projectId, assetId) => assetId === 'asset-history'
        ? sourcePath
        : join(projectRoot, `${assetId}.png`),
    },
    textArtifacts: {
      read: async (target) => ({
        target,
        content: target.kind === 'document' ? '# 第二版' : '<main>第四版</main>',
      }),
    },
    getAuthorizedProjectRoot: () => projectRoot,
    choosePath: async () => { choosePathCalls += 1; return options.onChoosePath ? options.onChoosePath() : options.choosePath },
    chooseDirectory: async () => { chooseDirectoryCalls += 1; return options.chooseDirectory },
    ...(options.receipts ? { receipts: options.receipts } : {}),
    runStableDirectoryNative: async (request, authorize) => {
      const roots = request.roots.map((path): StableDirectoryOpenedRoot => {
        const stat = lstatSync(path)
        return {
          requestedPath: path,
          canonicalPath: realpathSync(path),
          isDirectory: stat.isDirectory(),
          ...(stat.isFile() ? { size: stat.size } : {}),
          volume: String(stat.dev),
          fileId: String(stat.ino),
        }
      })
      if (!await authorize(roots)) throw new Error('目录授权被拒绝')
      const targetPath = join(request.roots.at(-1)!, request.artifactFileName!)
      if (request.mode === 'artifact-export-copy') {
        imageExports.push({ assetId: 'asset-history', targetPath })
        writeFileSync(targetPath, readFileSync(request.roots[0]!))
      } else {
        textExports.push({
          projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'document-1',
          kind: 'document', contentId: 'document-content-1', contentRevision: 2,
          targetPath, overwrite: request.overwrite === true,
        })
        writeFileSync(targetPath, request.content ?? '')
      }
      options.onNativeWrite?.()
      return { roots, entries: [], writeOutcome: { commitVisible: true, durabilityUncertain: false } }
    },
  })
  return {
    service,
    projectRoot,
    document,
    imageExports,
    textExports,
    execution: {
      context: {
        sessionId: 'session-1', projectId: 'project-1', runStartedAt: 1,
        explicitReferences: [], permissionCeiling: 'execute' as const,
      },
      operationId: 'operation-1',
      validateAccess: () => { validateAccessCalls += 1 },
    },
    get validateAccessCalls() { return validateAccessCalls },
    get choosePathCalls() { return choosePathCalls },
    get chooseDirectoryCalls() { return chooseDirectoryCalls },
  }
}

/** 构造图片历史版本的项目相对路径导出请求。 */
function createImageRequest(relativePath = 'exports/history.png'): CanvasArtifactExportRequest {
  return {
    projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-1',
    version: { kind: 'image', jobId: 'job-history' },
    destination: { kind: 'project', relativePath },
    overwrite: false,
    intent: 'explicit',
  }
}

describe('CanvasArtifactExportService', () => {
  test('Given 未采用的成功图片版本 When 显式导出 Then 精确导出该 Job 素材且不改变当前采用版本', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.projectRoot, 'exports'))

    const result = await fixture.service.export(createImageRequest(), fixture.execution)

    expect(result).toEqual({ status: 'saved', path: join(fixture.projectRoot, 'exports/history.png') })
    expect(fixture.imageExports).toEqual([{ assetId: 'asset-history', targetPath: join(fixture.projectRoot, 'exports/history.png') }])
    expect(fixture.document.nodes.find((node) => node.id === 'image-1')).toMatchObject({ adoptedAssetId: 'asset-current' })
    expect(fixture.validateAccessCalls).toBeGreaterThanOrEqual(2)
  })

  test('Given 文档历史 revision When 导出 Then 使用权威 contentId 精确写出且不采用历史版本', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.projectRoot, 'exports'))
    const request: CanvasArtifactExportRequest = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'document-1',
      version: { kind: 'document', revision: 2 },
      destination: { kind: 'project', relativePath: 'exports/history.md' },
      intent: 'explicit',
    }

    await fixture.service.export(request, fixture.execution)

    expect(fixture.textExports).toEqual([{
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'document-1',
      kind: 'document', contentId: 'document-content-1', contentRevision: 2,
      targetPath: join(fixture.projectRoot, 'exports/history.md'), overwrite: false,
    }])
    expect(fixture.document.nodes.find((node) => node.id === 'document-1')).toMatchObject({ contentRevision: 5 })
  })

  test('Given 项目相对路径越界或经过 symlink When 导出 Then 写入前拒绝', async () => {
    const fixture = createFixture()
    const outside = mkdtempSync(join(tmpdir(), 'proma-canvas-export-outside-'))
    temporaryRoots.push(outside)
    symlinkSync(outside, join(fixture.projectRoot, 'linked'))

    await expect(fixture.service.export(createImageRequest('../escaped.png'), fixture.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    await expect(fixture.service.export(createImageRequest('linked/escaped.png'), fixture.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 同名普通文件 When 未显式允许覆盖 Then 保留原文件并拒绝导出', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.projectRoot, 'exports'))
    const targetPath = join(fixture.projectRoot, 'exports/history.png')
    writeFileSync(targetPath, 'keep-me')

    await expect(fixture.service.export(createImageRequest(), fixture.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_EXISTS')

    expect(readFileSync(targetPath, 'utf8')).toBe('keep-me')
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 保存窗口取消 When 导出 Then 返回取消且不执行任何写入', async () => {
    const fixture = createFixture({ choosePath: undefined })
    const request: CanvasArtifactExportRequest = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
      version: { kind: 'webview', revision: 4 }, destination: { kind: 'dialog' }, intent: 'explicit',
    }

    await expect(fixture.service.export(request, fixture.execution))
      .resolves.toEqual({ status: 'cancelled' })
    expect(fixture.textExports).toHaveLength(0)
  })

  test('Given 保存窗口等待期间节点身份变化 When 继续导出 Then fresh 图校验拒绝旧目标', async () => {
    const fixture = createFixture()
    const targetPath = join(fixture.projectRoot, 'history.md')
    const service = createCanvasArtifactExportService({
      documents: {
        load: () => ({ document: fixture.document, writable: true, nodeIssues: [] }),
      },
      jobs: { getProjectJob: () => undefined },
      assets: {
        getAsset: () => { throw new Error('TEST_UNUSED') },
        resolveAssetPath: () => { throw new Error('TEST_UNUSED') },
      },
      textArtifacts: { read: async (target) => ({ target, content: '# 历史' }) },
      getAuthorizedProjectRoot: () => fixture.projectRoot,
      choosePath: async () => {
        const node = fixture.document.nodes.find((candidate) => candidate.id === 'document-1')
        if (node?.kind === 'document') node.documentId = 'replaced-content'
        return targetPath
      },
      runStableDirectoryNative: async () => { throw new Error('不应写入') },
    })

    await expect(service.export({
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'document-1',
      version: { kind: 'document', revision: 2 }, destination: { kind: 'dialog' }, intent: 'explicit',
    }, fixture.execution)).rejects.toThrow('CANVAS_ARTIFACT_EXPORT_VERSION_CONFLICT')
  })

  test('Given 最终权限复验期间目标父目录被替换 When 写入 Then 拒绝替换后的目录', async () => {
    const fixture = createFixture()
    const exportDirectory = join(fixture.projectRoot, 'exports')
    mkdirSync(exportDirectory)
    const movedDirectory = join(fixture.projectRoot, 'exports-moved')
    const outside = mkdtempSync(join(tmpdir(), 'proma-canvas-export-replacement-'))
    temporaryRoots.push(outside)
    let calls = 0
    const execution = {
      ...fixture.execution,
      validateAccess: () => {
        calls += 1
        if (calls === 3) {
          renameSync(exportDirectory, movedDirectory)
          symlinkSync(outside, exportDirectory)
        }
      },
    }

    await expect(fixture.service.export(createImageRequest(), execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_PATH_INVALID')
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 同一 operation 的保存窗口导出已完成 When 调用重放 Then 返回原结果且不再弹窗或写文件', async () => {
    const fixture = createFixture({ choosePath: undefined })
    const targetPath = join(fixture.projectRoot, 'history.png')
    const replayFixture = createFixture({ choosePath: targetPath })
    const request: CanvasArtifactExportRequest = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-1',
      version: { kind: 'image', jobId: 'job-history' }, destination: { kind: 'dialog' }, intent: 'explicit',
    }

    const first = await replayFixture.service.export(request, replayFixture.execution)
    const second = await replayFixture.service.export(request, replayFixture.execution)

    expect(second).toEqual(first)
    expect(replayFixture.choosePathCalls).toBe(1)
    expect(replayFixture.imageExports).toHaveLength(1)
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given prepared receipt 已落盘但目标缺失 When 同 operation 重放 Then fail closed 且不猜测重写', async () => {
    let stored: string | null = null
    let rejectFirstSave = true
    const receipts: CanvasArtifactExportReceiptStore = {
      load: async () => stored,
      saveActive: async (_target, _operationId, content) => {
        stored = content
        if (rejectFirstSave) {
          rejectFirstSave = false
          throw new Error('injected receipt failure')
        }
      },
      archiveCompleted: async () => undefined,
    }
    const fixture = createFixture({ receipts })
    mkdirSync(join(fixture.projectRoot, 'exports'))

    await expect(fixture.service.export(createImageRequest(), fixture.execution))
      .rejects.toThrow('injected receipt failure')
    await expect(fixture.service.export(createImageRequest(), fixture.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 三个精确版本 When 批量导出 Then 只选择一次目录并逐项返回成功文件', async () => {
    const fixture = createFixture()
    const exportDirectory = join(fixture.projectRoot, 'exports')
    mkdirSync(exportDirectory)
    const dialogFixture = createFixture({ chooseDirectory: exportDirectory })

    const result = await dialogFixture.service.exportBatch({
      projectId: 'project-1', canvasId: 'canvas-1', intent: 'explicit', destination: { kind: 'dialog' },
      items: [
        { nodeId: 'image-1', version: { kind: 'image', jobId: 'job-history' } },
        { nodeId: 'document-1', version: { kind: 'document', revision: 2 } },
        { nodeId: 'webview-1', version: { kind: 'webview', revision: 4 } },
      ],
    }, dialogFixture.execution)

    expect(result.status).toBe('completed')
    expect(result.files.map((entry) => entry.status)).toEqual(['saved', 'saved', 'saved'])
    expect(dialogFixture.chooseDirectoryCalls).toBe(1)
    expect(readFileSync(join(exportDirectory, '封面.png'), 'utf8')).toBe('image:asset-history')
    expect(readFileSync(join(exportDirectory, '需求.md'), 'utf8')).toBe('# 第二版')
    expect(readFileSync(join(exportDirectory, '页面.html'), 'utf8')).toBe('<main>第四版</main>')
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 两个服务实例竞争同一 operation When 首个已 claim 并等待窗口 Then 后者不重复弹窗或写文件', async () => {
    let stored: string | null = null
    const receipts: CanvasArtifactExportReceiptStore = {
      load: async () => stored,
      claimActive: async (_target, _operationId, content) => {
        if (stored !== null) return false
        stored = content
        return true
      },
      saveActive: async (_target, _operationId, content) => { stored = content },
      archiveCompleted: async (_target, _operationId, content) => { stored = content },
    }
    let releaseSelection: ((path: string) => void) | undefined
    const selection = new Promise<string>((resolveSelection) => { releaseSelection = resolveSelection })
    const first = createFixture({ receipts, onChoosePath: async () => selection })
    const second = createFixture({ receipts, choosePath: join(first.projectRoot, 'second.png') })
    const request: CanvasArtifactExportRequest = {
      projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'image-1',
      version: { kind: 'image', jobId: 'job-history' }, destination: { kind: 'dialog' }, intent: 'explicit',
    }
    const firstRun = first.service.export(request, first.execution)
    await Promise.resolve()
    await expect(second.service.export(request, second.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_COMMIT_UNCERTAIN')
    releaseSelection?.(join(first.projectRoot, 'first.png'))
    await expect(firstRun).resolves.toEqual({ status: 'saved', path: join(first.projectRoot, 'first.png') })

    expect(first.choosePathCalls).toBe(1)
    expect(second.choosePathCalls).toBe(0)
    expect(first.imageExports).toHaveLength(1)
    expect(second.imageExports).toHaveLength(0)
  })

  test('Given completed receipt 的结果路径被破坏 When 同 operation 重放 Then 严格解析拒绝且不返回伪造路径', async () => {
    let stored: string | null = null
    const receipts: CanvasArtifactExportReceiptStore = {
      load: async () => stored,
      claimActive: async (_target, _operationId, content) => { if (stored) return false; stored = content; return true },
      saveActive: async (_target, _operationId, content) => { stored = content },
      archiveCompleted: async (_target, _operationId, content) => { stored = content },
    }
    const fixture = createFixture({ receipts })
    mkdirSync(join(fixture.projectRoot, 'exports'))
    await fixture.service.export(createImageRequest(), fixture.execution)
    const receipt = JSON.parse(stored!) as {
      items: Array<{ path: string }>
      files: Array<{ status: string; path?: string }>
      result: { files: Array<{ status: string; path?: string }> }
    }
    receipt.items[0]!.path = 'relative/forged.png'
    receipt.files[0]!.path = 'relative/forged.png'
    receipt.result.files[0]!.path = 'relative/forged.png'
    stored = `${JSON.stringify(receipt)}\n`

    await expect(fixture.service.export(createImageRequest(), fixture.execution))
      .rejects.toThrow('CANVAS_ARTIFACT_EXPORT_RECEIPT_INVALID')
    expect(fixture.imageExports).toHaveLength(1)
  })

  test('Given 批量预检已有失败且目录选择取消 When 返回 Then 保留失败并按请求顺序取消其余项', async () => {
    const fixture = createFixture({ chooseDirectory: undefined })
    const result = await fixture.service.exportBatch({
      projectId: 'project-1', canvasId: 'canvas-1', intent: 'explicit', destination: { kind: 'dialog' },
      items: [
        { nodeId: 'image-1', version: { kind: 'image', jobId: 'job-history' } },
        { nodeId: 'missing', version: { kind: 'document', revision: 1 } },
      ],
    }, fixture.execution)

    expect(result).toEqual({ status: 'cancelled', files: [
      { nodeId: 'image-1', status: 'cancelled' },
      { nodeId: 'missing', status: 'failed', error: 'CANVAS_NODE_NOT_FOUND' },
    ] })
    expect(fixture.imageExports).toHaveLength(0)
  })

  test('Given 后项预检失败且前项可导出 When 批量提交 Then receipt 与公开结果始终保持请求顺序', async () => {
    const fixture = createFixture()
    mkdirSync(join(fixture.projectRoot, 'exports'))
    const result = await fixture.service.exportBatch({
      projectId: 'project-1', canvasId: 'canvas-1', intent: 'explicit',
      destination: { kind: 'project', relativeDirectory: 'exports' },
      items: [
        { nodeId: 'image-1', version: { kind: 'image', jobId: 'job-history' } },
        { nodeId: 'missing', version: { kind: 'document', revision: 1 } },
      ],
    }, fixture.execution)

    expect(result.files.map((file) => [file.nodeId, file.status])).toEqual([
      ['image-1', 'saved'],
      ['missing', 'failed'],
    ])
  })

  test('Given 首项提交后权限被撤销 When 批量继续 Then 整体抛错并停止后续文件', async () => {
    const controller = new AbortController()
    let writes = 0
    const fixture = createFixture({ onNativeWrite: () => { writes += 1; controller.abort(new Error('CANVAS_ACCESS_DENIED')) } })
    mkdirSync(join(fixture.projectRoot, 'exports'))

    await expect(fixture.service.exportBatch({
      projectId: 'project-1', canvasId: 'canvas-1', intent: 'explicit',
      destination: { kind: 'project', relativeDirectory: 'exports' },
      items: [
        { nodeId: 'image-1', version: { kind: 'image', jobId: 'job-history' } },
        { nodeId: 'document-1', version: { kind: 'document', revision: 2 } },
      ],
    }, { ...fixture.execution, signal: controller.signal })).rejects.toThrow('CANVAS_ACCESS_DENIED')
    expect(writes).toBe(1)
    expect(fixture.imageExports).toHaveLength(1)
    expect(fixture.textExports).toHaveLength(0)
  })
})
