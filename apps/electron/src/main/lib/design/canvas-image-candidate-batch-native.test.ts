import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createEmptyCanvasDocument } from '@proma/shared'
import type {
  CanvasDocument,
  CanvasImageCandidateBatch,
  CanvasImageModuleConfig,
  CanvasNode,
  CanvasTarget,
} from '@proma/shared'
import { createStableDirectoryNativeHost } from '../stable-directory-native-host'
import type {
  StableDirectoryAuthorization,
  StableDirectoryNativeRequest,
} from '../stable-directory-native-host'
import { createCanvasDependencyStateService } from './canvas-dependency-state-service'
import { createCanvasImageCandidateBatchService } from './canvas-image-candidate-batch-service'
import { createCanvasImageCandidateBatchStore } from './canvas-image-candidate-batch-store'

/** Electron 应用根目录。 */
const electronAppRoot = resolve(import.meta.dir, '../../../..')
/** 当前平台真实 helper 路径。 */
const nativeHelperPath = resolve(
  electronAppRoot,
  `resources/stable-directory/stable-directory-helper${process.platform === 'win32' ? '.exe' : ''}`,
)
/** 当前环境是否已有可运行的真实 helper；构建任务负责生成它。 */
const nativeHelperAvailable = (process.platform === 'darwin' || process.platform === 'win32')
  && existsSync(nativeHelperPath)
/** 每个用例独占的临时 Canvas 根，结束后统一清理。 */
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 测试使用的固定 Canvas 目标。 */
const target: CanvasTarget = { projectId: 'project-native-benchmark', canvasId: 'canvas-native-benchmark' }

/** 生成符合 Host UUID 文件名合同的稳定测试身份。 */
function uuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`
}

/** 从生产合同稳定派生首次采用批次 ID。 */
function initialAdoptionBatchId(nodeId: string, imageModuleId: string, jobId: string): string {
  return `agent-canvas-${createHash('sha256').update(JSON.stringify([
    'initial-image-adoption', target.projectId, target.canvasId, nodeId, imageModuleId, jobId,
  ])).digest('hex')}`
}

/** 从首次采用批次 ID 稳定派生 helper 支持的 operation UUID。 */
function initialAdoptionOperationId(batchId: string): string {
  const hash = createHash('sha256').update(batchId).digest('hex')
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

/** 真实 helper 集成现场及协议调用计数。 */
interface NativeFixture {
  root: string
  transactions: string
  modeCounts: Map<StableDirectoryNativeRequest['mode'], number>
  store: ReturnType<typeof createCanvasImageCandidateBatchStore>
}

/** 创建只授权临时目录的生产 Store 现场。 */
function createNativeFixture(): NativeFixture {
  const root = mkdtempSync(join(tmpdir(), 'proma-image-candidate-native-'))
  temporaryRoots.push(root)
  const transactions = join(root, 'transactions')
  mkdirSync(transactions)
  const canonicalRoot = realpathSync(root)
  const host = createStableDirectoryNativeHost()
  const modeCounts = new Map<StableDirectoryNativeRequest['mode'], number>()
  /** 用真实 helper 执行生产协议，并统计每种协议调用数。 */
  const runNative = async (
    request: StableDirectoryNativeRequest,
    authorize: StableDirectoryAuthorization,
  ) => {
    modeCounts.set(request.mode, (modeCounts.get(request.mode) ?? 0) + 1)
    return host.run(request, authorize, { helperPath: () => nativeHelperPath })
  }
  const store = createCanvasImageCandidateBatchStore({
    documents: {
      loadWithDirectoryCapability: () => ({
        snapshot: {
          document: createEmptyCanvasDocument(target.projectId, target.canvasId, 1),
          writable: true,
          nodeIssues: [],
        },
        openSingleChildDirectory: (name) => {
          if (name !== 'transactions') throw new Error('TEST_CHILD_INVALID')
          return {
            path: transactions,
            rootPath: root,
            assertValid: () => {
              if (realpathSync(root) !== canonicalRoot) throw new Error('TEST_ROOT_CHANGED')
            },
            authorizeOpenedRoots: (opened) => opened.length === 1
              && opened[0]?.canonicalPath === canonicalRoot
              && opened[0]?.isDirectory === true,
          }
        },
      }),
    },
    runStableDirectoryNative: runNative,
  })
  return { root, transactions, modeCounts, store }
}

/** 写入一个保持在活动区的候选批次。 */
function writeActiveBatch(
  transactions: string,
  index: number,
  status: 'running' | 'ready' = 'running',
): CanvasImageCandidateBatch {
  const batchId = uuid(index + 1)
  const batch: CanvasImageCandidateBatch = {
    schemaVersion: 1,
    batchId,
    ...target,
    source: 'single',
    sourceSessionId: null,
    sourceToolCallId: null,
    status,
    entries: [{
      nodeId: `existing-node-${index}`,
      imageModuleId: `existing-module-${index}`,
      initialAdoptedAssetId: status === 'ready' ? 'old-asset' : null,
      initialConfigRevision: 1,
      jobId: `existing-job-${index}`,
      candidateAssetId: status === 'ready' ? `existing-asset-${index}` : null,
      status: status === 'ready' ? 'candidate' : 'queued',
      error: null,
    }],
    adoption: null,
    createdAt: 1,
    updatedAt: 1,
  }
  writeFileSync(
    join(transactions, `image-candidate-batch-${batchId}.json`),
    `${JSON.stringify(batch, null, 2)}\n`,
  )
  return batch
}

test.skipIf(!nativeHelperAvailable)('Given 310 个活动批次 When 精确读取 10 个批次 Then 使用 read 且不扫描目录', async () => {
  const fixture = createNativeFixture()
  /** 300 个长期活动事务加 10 个本轮任务，锁定大目录读取成本。 */
  const batches = Array.from({ length: 310 }, (_, index) => (
    writeActiveBatch(fixture.transactions, index, index < 300 && index % 2 === 1 ? 'ready' : 'running')
  ))

  for (const batch of batches.slice(300)) {
    expect((await fixture.store.load(target, batch.batchId)).batchId).toBe(batch.batchId)
  }

  expect(fixture.modeCounts.get('canvas-intent-read')).toBe(10)
  expect(fixture.modeCounts.get('canvas-intent-scan') ?? 0).toBe(0)
}, 30_000)

test.skipIf(!nativeHelperAvailable)('Given 310 个活动批次与 1000 节点 When 首次生成 10 个结果 Then 每个结果只执行一次恢复扫描且归档后可重读', async () => {
  const fixture = createNativeFixture()
  /** 原目录保持 300 个不可归档活动批次。 */
  for (let index = 0; index < 300; index += 1) {
    writeActiveBatch(fixture.transactions, index, index % 2 === 0 ? 'running' : 'ready')
  }
  /** 本轮 10 个空图片节点的生成批次。 */
  const generatedBatches = Array.from({ length: 10 }, (_, index) => {
    const batch = writeActiveBatch(fixture.transactions, 300 + index)
    const nodeId = `generated-node-${index}`
    batch.entries = [{
      nodeId,
      imageModuleId: `generated-module-${index}`,
      initialAdoptedAssetId: null,
      initialConfigRevision: 1,
      jobId: `generated-job-${index}`,
      candidateAssetId: null,
      status: 'queued',
      error: null,
    }]
    writeFileSync(
      join(fixture.transactions, `image-candidate-batch-${batch.batchId}.json`),
      `${JSON.stringify(batch, null, 2)}\n`,
    )
    return batch
  })
  /** 1000 节点图用于覆盖首次采用中的图投影与哈希成本。 */
  const configs = new Map<string, CanvasImageModuleConfig>()
  const nodes: CanvasNode[] = Array.from({ length: 1000 }, (_, index) => {
    const nodeId = index < 10 ? `generated-node-${index}` : `large-node-${index}`
    const imageModuleId = index < 10 ? `generated-module-${index}` : `large-module-${index}`
    configs.set(nodeId, {
      schemaVersion: 2,
      kind: 'image',
      contentId: imageModuleId,
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
      prompt: '原生性能回归',
      selectedModelProfileId: 'model-1',
      aspectRatio: '1:1',
      imageSize: 'auto',
      contextMode: 'none',
      adoptedAssetId: null,
    })
    return {
      id: nodeId,
      kind: 'image',
      title: `图片 ${index}`,
      position: { x: index * 10, y: 0 },
      imageModuleId,
    }
  })
  let canvas: CanvasDocument = {
    schemaVersion: 4,
    ...target,
    revision: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes,
    edges: [],
    createdAt: 1,
    updatedAt: 1,
  }
  const service = createCanvasImageCandidateBatchService({
    store: fixture.store,
    dependencyState: createCanvasDependencyStateService(),
    runExclusive: async (_input, effect) => effect(),
    loadConfig: async (input) => structuredClone(configs.get(input.nodeId)!),
    adoptAsset: async (input, expectedRevision, assetId) => {
      const current = configs.get(input.nodeId)!
      if (current.revision !== expectedRevision) throw new Error('TEST_CONFIG_CONFLICT')
      const next = { ...current, revision: current.revision + 1, adoptedAssetId: assetId }
      configs.set(input.nodeId, next)
      return structuredClone(next)
    },
    loadCanvas: async () => structuredClone(canvas),
    applyCanvasProjection: async (_input, expectedRevision, projectedNodes) => {
      if (canvas.revision !== expectedRevision) throw new Error('TEST_CANVAS_CONFLICT')
      const replacements = new Map(projectedNodes.map((node) => [node.id, node]))
      canvas = {
        ...canvas,
        revision: canvas.revision + 1,
        nodes: canvas.nodes.map((node) => replacements.get(node.id) ?? node),
        updatedAt: 2,
      }
      return structuredClone(canvas)
    },
    retryEntry: async () => ({ jobId: 'unused', start: () => undefined }),
    validateCandidate: async () => undefined,
    now: () => 2,
  })

  for (let index = 0; index < generatedBatches.length; index += 1) {
    await service.recordJobTerminal({
      ...target,
      candidateBatchId: generatedBatches[index]!.batchId,
      jobId: `generated-job-${index}`,
      status: 'succeeded',
      outputAssetId: `generated-asset-${index}`,
      error: null,
    })
  }

  expect(fixture.modeCounts.get('canvas-intent-scan')).toBe(10)
  for (let index = 0; index < 10; index += 1) {
    expect(configs.get(`generated-node-${index}`)?.adoptedAssetId).toBe(`generated-asset-${index}`)
  }

  /** 最后一个终态批次与 intent 尚在活动区，本次既有扫描必须同时归档二者。 */
  const index = 9
  const receiptBatchId = initialAdoptionBatchId(
    `generated-node-${index}`,
    `generated-module-${index}`,
    `generated-job-${index}`,
  )
  const operationId = initialAdoptionOperationId(receiptBatchId)
  const activeBatchPath = join(fixture.transactions, `image-candidate-batch-${receiptBatchId}.json`)
  const activeIntentPath = join(fixture.transactions, `image-candidate-adoption-${operationId}.json`)
  expect(existsSync(activeBatchPath)).toBe(true)
  expect(existsSync(activeIntentPath)).toBe(true)

  await fixture.store.scanAdoptionIntents(target)
  expect(fixture.modeCounts.get('canvas-intent-scan')).toBe(11)
  expect(existsSync(activeBatchPath)).toBe(false)
  expect(existsSync(activeIntentPath)).toBe(false)
  expect(await fixture.store.load(target, receiptBatchId)).toMatchObject({ status: 'adopted' })
  expect(await fixture.store.loadAdoptionIntent(target, operationId)).toMatchObject({ state: 'batch-committed' })
}, 30_000)
