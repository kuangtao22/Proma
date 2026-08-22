import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import sharp from 'sharp'
import { createDesignPathResolver } from './design-paths'
import { createDesignStore } from './design-store'
import type { DesignStore } from './design-store'
import { DesignAssetProcessingQueue, DesignAssetService, promoteStagedFile } from './design-asset-service'

describe('Design 素材安全服务', () => {
  /** 每个测试隔离使用的项目正式根。 */
  let projectRoot: string
  /** 每个测试隔离使用的全局缓存根。 */
  let configRoot: string
  /** 模拟主进程选择器授权的源文件目录。 */
  let sourceRoot: string
  /** 测试使用的 PNG 图片路径。 */
  let fixturePath: string
  /** 测试服务解析出的可信 Design 路径。 */
  let paths: ReturnType<ReturnType<typeof createDesignPathResolver>['resolve']>
  /** 测试服务实例。 */
  let service: DesignAssetService
  /** 测试服务共享的真实 revision store。 */
  let store: DesignStore

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'proma-design-asset-project-'))
    configRoot = mkdtempSync(join(tmpdir(), 'proma-design-asset-config-'))
    sourceRoot = mkdtempSync(join(tmpdir(), 'proma-design-asset-source-'))
    fixturePath = join(sourceRoot, 'pixel.png')
    await sharp({
      create: {
        width: 1,
        height: 1,
        channels: 4,
        background: { r: 255, g: 0, b: 0, alpha: 1 },
      },
    }).png().toFile(fixturePath)

    /** 只将固定测试项目解析到临时目录的可信路径解析器。 */
    const pathResolver = createDesignPathResolver({
      getWorkspace: () => ({
        id: 'project-1',
        name: '项目',
        slug: 'stable-slug',
        projectRootPath: projectRoot,
        createdAt: 1,
        updatedAt: 1,
      }),
      getProjectFilesPath: () => projectRoot,
      getConfigDir: () => configRoot,
    })
    /** 使用真实 revision store 验证素材元数据提交合同。 */
    store = createDesignStore({ pathResolver, now: () => 100 })
    store.load('project-1')
    paths = pathResolver.resolve('project-1')
    service = new DesignAssetService({
      pathResolver,
      store,
      now: () => 200,
      runWorkspaceWrite: (_projectId, effect) => effect(),
      registerDirectoryPath: (directoryPath) => `proma-file://${basename(directoryPath)}`,
      revokePathUrl: () => {},
      warn: () => {},
    })
  })

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true })
    rmSync(configRoot, { recursive: true, force: true })
    rmSync(sourceRoot, { recursive: true, force: true })
  })

  test('Given 有效 PNG When 导入 Then 生成校验值、正式素材和 WebP 缩略图', async () => {
    const result = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })

    expect(result).toHaveLength(1)
    expect(result[0]?.mediaType).toBe('image/png')
    expect(result[0]?.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(result[0]?.filename).toBe('pixel.png')
    expect(result[0]?.relativePath).toMatch(/^assets\/[0-9a-f-]+\.png$/)
    expect(existsSync(join(paths.assetsDir, basename(result[0]!.relativePath)))).toBe(true)
    const thumbnailPath = join(paths.thumbnailsDir, basename(result[0]!.thumbnailRelativePath))
    expect(existsSync(thumbnailPath)).toBe(true)
    expect((await sharp(thumbnailPath).metadata()).format).toBe('webp')
  })

  test('Given 导入元数据已提交 When 确认批次 Then 保留正式文件并消费精确 journal', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    expect(listPromotionJournals()).toHaveLength(1)

    batch.commit()

    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(true)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(true)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 导入元数据提交失败 When 回滚批次 Then 删除未引用正式文件和精确 journal', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    expect(listPromotionJournals()).toHaveLength(1)

    batch.rollback()

    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(false)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(false)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 有效导入完成但 staging 清理失败 When 确认批次 Then 保留 journal 供重启恢复', async () => {
    service = createService({
      runtimeId: 'runtime-import-commit-staging-failed',
      cleanupPath: (path) => {
        if (path.startsWith(paths.stagingDir)) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
    })
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])

    batch.commit()

    expect(readdirSync(paths.stagingDir)).toHaveLength(1)
    expect(listPromotionJournals()).toHaveLength(1)
    service = createService({ runtimeId: 'runtime-import-commit-staging-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.stagingDir)).toEqual([])
    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(true)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(true)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 有效导入完成但 staging 清理失败 When 回滚批次 Then 保留 journal 供重启恢复', async () => {
    service = createService({
      runtimeId: 'runtime-import-rollback-staging-failed',
      cleanupPath: (path) => {
        if (path.startsWith(paths.stagingDir)) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
    })
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!

    batch.rollback()

    expect(readdirSync(paths.stagingDir)).toHaveLength(1)
    expect(listPromotionJournals()).toHaveLength(1)
    service = createService({ runtimeId: 'runtime-import-rollback-staging-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.stagingDir)).toEqual([])
    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(false)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(false)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 元数据即时可读但 durability 未确认 When 回滚批次 Then 保留文件与 journal 到下一进程', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])

    batch.rollback()

    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(true)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(true)
    expect(listPromotionJournals()).toHaveLength(1)

    /** 模拟崩溃后 canvas 回退到未引用状态，再由新 runtime 依据磁盘事实清理。 */
    store.mutate('project-1', 1, [{ type: 'remove-assets', assetIds: [asset.id] }])
    service = createService({ runtimeId: 'runtime-after-restart' })
    service.recoverPromotionJournals('project-1')

    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(false)
    expect(existsSync(join(paths.cacheRoot, asset.thumbnailRelativePath))).toBe(false)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given JPEG、GIF 与 WebP When 导入 Then 按真实签名记录规范媒体类型', async () => {
    /** 三种其余受支持格式及预期 MIME。 */
    const fixtures = [
      {
        path: join(sourceRoot, 'pixel.jpg'),
        mediaType: 'image/jpeg',
        write: () => sharp(fixturePath).jpeg().toFile(join(sourceRoot, 'pixel.jpg')),
      },
      {
        path: join(sourceRoot, 'pixel.gif'),
        mediaType: 'image/gif',
        write: () => sharp(fixturePath).gif().toFile(join(sourceRoot, 'pixel.gif')),
      },
      {
        path: join(sourceRoot, 'pixel.webp'),
        mediaType: 'image/webp',
        write: () => sharp(fixturePath).webp().toFile(join(sourceRoot, 'pixel.webp')),
      },
    ] as const
    for (const fixture of fixtures) await fixture.write()

    const result = await service.importAuthorizedFiles(
      'project-1',
      fixtures.map((fixture) => fixture.path),
      { kind: 'picker' },
    )

    expect(result.map((asset) => asset.mediaType)).toEqual(fixtures.map((fixture) => fixture.mediaType))
  })

  test('Given 扩展名伪装的文本 When 导入 Then 按签名拒绝且正式目录无半成品', async () => {
    const fakePngPath = join(sourceRoot, 'fake.png')
    writeFileSync(fakePngPath, 'not an image', 'utf8')

    await expect(service.importAuthorizedFiles('project-1', [fakePngPath], { kind: 'picker' }))
      .rejects.toThrow('不支持或损坏的图片')
    expect(readdirSync(paths.assetsDir)).toEqual([])
    expect(readdirSync(paths.thumbnailsDir)).toEqual([])
    expect(readdirSync(paths.stagingDir)).toEqual([])
  })

  test('Given 批次第二个文件无效 When 导入 Then 清理整批 staging 且不提交首个素材', async () => {
    const fakePngPath = join(sourceRoot, 'fake.png')
    writeFileSync(fakePngPath, 'not an image', 'utf8')

    await expect(service.importAuthorizedFiles('project-1', [fixturePath, fakePngPath], { kind: 'picker' }))
      .rejects.toThrow('不支持或损坏的图片')
    expect(readdirSync(paths.assetsDir)).toEqual([])
    expect(readdirSync(paths.thumbnailsDir)).toEqual([])
    expect(readdirSync(paths.stagingDir)).toEqual([])
  })

  test('Given staging 与项目素材目录跨卷 When 导入 Then 经目标卷临时文件原子提交整批素材', async () => {
    /** 记录 staging 到正式目录触发的跨卷降级次数。 */
    let crossVolumePromotions = 0
    service = createService({
      renameFile: (sourcePath, targetPath) => {
        if (sourcePath.startsWith(paths.stagingDir)) {
          crossVolumePromotions += 1
          throw createFileSystemError('EXDEV')
        }
        renameSync(sourcePath, targetPath)
      },
    })

    const result = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })

    expect(result).toHaveLength(1)
    expect(crossVolumePromotions).toBe(2)
    expect(readdirSync(paths.assetsDir)).toEqual([basename(result[0]!.relativePath)])
    expect(readdirSync(paths.thumbnailsDir)).toEqual([basename(result[0]!.thumbnailRelativePath)])
    expect(readdirSync(paths.assetsDir).some((name) => name.includes('.proma-promote-'))).toBe(false)
    expect(readdirSync(paths.stagingDir)).toEqual([])
  })

  test('Given 跨卷复制完成但目标卷 rename 失败 When 导入 Then 清理临时与整批正式文件', async () => {
    service = createService({
      renameFile: (sourcePath, targetPath) => {
        if (sourcePath.startsWith(paths.stagingDir)) throw createFileSystemError('EXDEV')
        if (basename(sourcePath).startsWith('.proma-promote-')) throw createFileSystemError('EIO')
        renameSync(sourcePath, targetPath)
      },
    })

    await expect(service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' }))
      .rejects.toThrow()
    expect(readdirSync(paths.assetsDir)).toEqual([])
    expect(readdirSync(paths.thumbnailsDir)).toEqual([])
    expect(readdirSync(paths.stagingDir)).toEqual([])
  })

  test('Given 导入失败且目标卷临时文件无法删除 When 回滚 Then 保留原错误与 journal 供重启恢复', async () => {
    /** 清理故障必须产生可诊断 warning，但不得覆盖目标 rename 的 EIO。 */
    const warnings: string[] = []
    service = createService({
      runtimeId: 'runtime-temp-cleanup-failed',
      renameFile: (sourcePath, targetPath) => {
        if (sourcePath.startsWith(paths.stagingDir)) throw createFileSystemError('EXDEV')
        if (basename(sourcePath).startsWith('.proma-promote-')) throw createFileSystemError('EIO')
        renameSync(sourcePath, targetPath)
      },
      cleanupPath: (path) => {
        if (basename(path).startsWith('.proma-promote-')) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
      warn: (message) => warnings.push(message),
    })

    await expect(service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' }))
      .rejects.toThrow('EIO')
    expect(warnings.some((message) => message.includes('清理失败'))).toBe(true)
    expect(listPromotionJournals()).toHaveLength(1)
    expect(readdirSync(paths.assetsDir).some((name) => name.startsWith('.proma-promote-'))).toBe(true)

    service = createService({ runtimeId: 'runtime-temp-cleanup-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.assetsDir)).toEqual([])
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 导入校验失败且 staging 无法删除 When 回滚 Then 保留原错误与 journal 供重启恢复', async () => {
    const fakePngPath = join(sourceRoot, 'staging-cleanup-failure.png')
    writeFileSync(fakePngPath, 'not an image', 'utf8')
    const warnings: string[] = []
    service = createService({
      runtimeId: 'runtime-staging-cleanup-failed',
      cleanupPath: (path) => {
        if (path.startsWith(paths.stagingDir)) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
      warn: (message) => warnings.push(message),
    })

    await expect(service.importAuthorizedFiles('project-1', [fakePngPath], { kind: 'picker' }))
      .rejects.toThrow('不支持或损坏的图片')
    expect(warnings.some((message) => message.includes('staging 清理失败'))).toBe(true)
    expect(readdirSync(paths.stagingDir)).toHaveLength(1)
    expect(listPromotionJournals()).toHaveLength(1)

    service = createService({ runtimeId: 'runtime-staging-cleanup-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.stagingDir)).toEqual([])
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 跨卷提升成功后源路径被重新创建 When 完成清理 Then 保留已提交目标', () => {
    const stagingPath = join(sourceRoot, 'staged.png')
    const targetPath = join(paths.assetsDir, 'promoted.png')
    writeFileSync(stagingPath, readFileSync(fixturePath))

    promoteStagedFile(stagingPath, targetPath, {
      renameFile: (sourcePath, destinationPath) => {
        if (sourcePath === stagingPath) throw createFileSystemError('EXDEV')
        renameSync(sourcePath, destinationPath)
      },
      removeFile: (filePath) => {
        rmSync(filePath)
        if (filePath === stagingPath) writeFileSync(stagingPath, 'recreated')
      },
    })

    expect(existsSync(targetPath)).toBe(true)
    expect(readFileSync(targetPath)).toEqual(readFileSync(fixturePath))
  })

  test('Given 两个并发图片请求 When 进入处理队列 Then 同时只运行一个 Sharp 任务', async () => {
    const queue = new DesignAssetProcessingQueue({ maxBatchBytes: 128, maxFiles: 4 })
    /** 第一项任务完成时机由测试控制。 */
    let finishFirst: (() => void) | undefined
    /** 当前进入执行区的任务数量。 */
    let activeTasks = 0
    /** 测试观察到的最大并发数。 */
    let maximumActiveTasks = 0
    const first = queue.run([64], async () => {
      activeTasks += 1
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks)
      await new Promise<void>((resolve) => { finishFirst = resolve })
      activeTasks -= 1
    })
    const second = queue.run([64], async () => {
      activeTasks += 1
      maximumActiveTasks = Math.max(maximumActiveTasks, activeTasks)
      activeTasks -= 1
    })
    await Promise.resolve()

    expect(maximumActiveTasks).toBe(1)
    finishFirst?.()
    await Promise.all([first, second])
    expect(maximumActiveTasks).toBe(1)
  })

  test('Given 批次累计字节或文件数超预算 When 排队 Then 在读取 Buffer 前拒绝', async () => {
    const queue = new DesignAssetProcessingQueue({ maxBatchBytes: 100, maxFiles: 2 })

    await expect(queue.run([60, 41], async () => {})).rejects.toThrow('批次图片累计大小超出限制')
    await expect(queue.run([1, 1, 1], async () => {})).rejects.toThrow('批次图片数量超出限制')
  })

  test('Given 上一进程 promotion 未写入 canvas When 新实例恢复 Then 清理正式孤儿与 journal', async () => {
    service = createService({ runtimeId: 'runtime-old' })
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const orphanPath = join(paths.designRoot, asset!.relativePath)
    expect(existsSync(orphanPath)).toBe(true)

    service = createService({ runtimeId: 'runtime-new' })
    service.recoverPromotionJournals('project-1')

    expect(existsSync(orphanPath)).toBe(false)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given promotion 已被 canvas 引用 When 新实例恢复 Then 保留正式文件并清理 journal', async () => {
    service = createService({ runtimeId: 'runtime-old' })
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    const referencedPath = join(paths.designRoot, asset!.relativePath)

    service = createService({ runtimeId: 'runtime-new' })
    service.recoverPromotionJournals('project-1')

    expect(existsSync(referencedPath)).toBe(true)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 旧进程留下跨卷临时文件与 staging When 新实例恢复 Then 按 journal 全部清理', async () => {
    service = createService({ runtimeId: 'runtime-old' })
    await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const journalName = listPromotionJournals()[0]!
    /** 红灯阶段字段允许缺失，断言确保 journal 先具备完整崩溃恢复信息。 */
    const journal = JSON.parse(readFileSync(join(paths.jobsDir, 'promotions', journalName), 'utf8')) as {
      stagingDirectoryName?: string
      assetTemporaryNames?: string[]
      thumbnailTemporaryNames?: string[]
    }

    expect(journal.stagingDirectoryName).toBeString()
    expect(journal.assetTemporaryNames).toHaveLength(1)
    expect(journal.thumbnailTemporaryNames).toHaveLength(1)
    const abandonedStaging = join(paths.stagingDir, journal.stagingDirectoryName!)
    const abandonedAssetTemporary = join(paths.assetsDir, journal.assetTemporaryNames![0]!)
    const abandonedThumbnailTemporary = join(paths.thumbnailsDir, journal.thumbnailTemporaryNames![0]!)
    mkdirSync(abandonedStaging)
    writeFileSync(join(abandonedStaging, 'partial'), 'partial')
    writeFileSync(abandonedAssetTemporary, 'partial')
    writeFileSync(abandonedThumbnailTemporary, 'partial')

    service = createService({ runtimeId: 'runtime-new' })
    service.recoverPromotionJournals('project-1')

    expect(existsSync(abandonedStaging)).toBe(false)
    expect(existsSync(abandonedAssetTemporary)).toBe(false)
    expect(existsSync(abandonedThumbnailTemporary)).toBe(false)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given 文件超过 64 MiB When 导入 Then 在解码前拒绝', async () => {
    const oversizedPath = join(sourceRoot, 'oversized.png')
    writeFileSync(oversizedPath, '')
    truncateSync(oversizedPath, 64 * 1024 * 1024 + 1)

    await expect(service.importAuthorizedFiles('project-1', [oversizedPath], { kind: 'picker' }))
      .rejects.toThrow('图片不能超过 64 MiB')
  })

  test('Given PNG 声明超过 64000000 pixels When 导入 Then 在 Sharp 元数据边界拒绝', async () => {
    /** 直接修改 IHDR 尺寸并重算 CRC，避免测试自身分配超大像素缓冲。 */
    const oversizedPixels = Buffer.from(readFileSync(fixturePath))
    oversizedPixels.writeUInt32BE(8_001, 16)
    oversizedPixels.writeUInt32BE(8_000, 20)
    oversizedPixels.writeUInt32BE(calculateCrc32(oversizedPixels.subarray(12, 29)), 29)
    const oversizedPixelsPath = join(sourceRoot, 'oversized-pixels.png')
    writeFileSync(oversizedPixelsPath, oversizedPixels)

    await expect(service.importAuthorizedFiles('project-1', [oversizedPixelsPath], { kind: 'picker' }))
      .rejects.toThrow()
    expect(readdirSync(paths.assetsDir)).toEqual([])
  })

  test('Given 授权路径是符号链接 When 导入 Then 拒绝读取链接目标', async () => {
    const symlinkPath = join(sourceRoot, 'linked.png')
    symlinkSync(fixturePath, symlinkPath)

    await expect(service.importAuthorizedFiles('project-1', [symlinkPath], { kind: 'picker' }))
      .rejects.toThrow('图片必须是实际普通文件')
  })

  test('Given 素材仍被节点引用 When 删除 Then 拒绝删除原图', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    expect(asset).toBeDefined()
    let document = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    document = store.mutate('project-1', document.revision, [{
      type: 'upsert-nodes',
      nodes: [{
        id: 'node-1',
        kind: 'asset',
        assetId: asset!.id,
        position: { x: 0, y: 0 },
        width: 1,
        height: 1,
        zIndex: 1,
      }],
    }])

    expect(() => service.deleteAsset('project-1', asset!.id, document.revision))
      .toThrow('素材仍被画布节点引用')
    expect(existsSync(service.resolveAssetPath('project-1', asset!.id))).toBe(true)
  })

  test('Given 素材未被引用 When 删除 Then 先提交元数据再原子删除文件', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])

    const result = service.deleteAsset('project-1', asset!.id, withAsset.revision)

    expect(result.assets).toEqual([])
    expect(existsSync(join(paths.assetsDir, basename(asset!.relativePath)))).toBe(false)
    expect(existsSync(join(paths.thumbnailsDir, basename(asset!.thumbnailRelativePath)))).toBe(false)
  })

  test('Given tmp 或 backup 恢复候选 When 首个素材操作是导出 Then 要求重载且不创建目标文件', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    batch.commit()

    for (const recoverySource of ['tmp', 'backup'] as const) {
      forceCanvasRecovery(recoverySource)
      const targetPath = join(sourceRoot, `recovery-export-${recoverySource}.png`)

      await expect(service.exportAsset('project-1', asset.id, targetPath))
        .rejects.toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
      expect(existsSync(targetPath)).toBe(false)
    }
  })

  test('Given tmp 或 backup 恢复候选 When 删除素材 Then 要求重载且不修改元数据或文件', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    batch.commit()
    const assetPath = join(paths.assetsDir, basename(asset.relativePath))
    const thumbnailPath = join(paths.thumbnailsDir, basename(asset.thumbnailRelativePath))

    for (const recoverySource of ['tmp', 'backup'] as const) {
      forceCanvasRecovery(recoverySource)

      expect(() => service.deleteAsset('project-1', asset.id, withAsset.revision))
        .toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
      expect(store.load('project-1').document.assets.map((item) => item.id)).toEqual([asset.id])
      expect(existsSync(assetPath)).toBe(true)
      expect(existsSync(thumbnailPath)).toBe(true)
    }
  })

  test('Given tmp 或 backup 恢复候选 When 重新定位素材 Then 要求重载且不创建 staging 或新文件', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    batch.commit()
    const replacementPath = join(sourceRoot, 'recovery-replacement.webp')
    await sharp(fixturePath).webp().toFile(replacementPath)

    for (const recoverySource of ['tmp', 'backup'] as const) {
      forceCanvasRecovery(recoverySource)
      const assetNames = readdirSync(paths.assetsDir)
      const thumbnailNames = readdirSync(paths.thumbnailsDir)

      await expect(service.relinkAsset('project-1', asset.id, replacementPath, withAsset.revision))
        .rejects.toThrow(`DESIGN_RECOVERY_REQUIRED: recoveredFrom=${recoverySource}`)
      expect(store.load('project-1').document.assets).toEqual([asset])
      expect(readdirSync(paths.assetsDir)).toEqual(assetNames)
      expect(readdirSync(paths.thumbnailsDir)).toEqual(thumbnailNames)
      expect(readdirSync(paths.stagingDir)).toEqual([])
      expect(listPromotionJournals()).toEqual([])
    }
  })

  test('Given 缺失素材 When 重新定位 Then 保留版本来源并替换文件元数据', async () => {
    const [parent] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], {
      kind: 'agent',
      sourceSessionId: 'session-1',
      parentAssetId: parent!.id,
      prompt: '修复图片',
    })
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [parent!, asset!] }])
    rmSync(service.resolveAssetPath('project-1', asset!.id))
    const replacementPath = join(sourceRoot, 'replacement.jpg')
    await sharp({
      create: {
        width: 3,
        height: 2,
        channels: 3,
        background: { r: 0, g: 0, b: 255 },
      },
    }).jpeg().toFile(replacementPath)

    const result = await service.relinkAsset('project-1', asset!.id, replacementPath, withAsset.revision)
    const relinked = result.assets.find((item) => item.id === asset!.id)
    expect(relinked).toMatchObject({
      id: asset!.id,
      mediaType: 'image/jpeg',
      width: 3,
      height: 2,
      sourceSessionId: 'session-1',
      parentAssetId: parent!.id,
      prompt: '修复图片',
    })
    expect(existsSync(service.resolveAssetPath('project-1', asset!.id))).toBe(true)
  })

  test('Given staging 与项目素材目录跨卷 When 重新定位 Then 原位提交新素材并清理旧文件', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    const oldAssetPath = service.resolveAssetPath('project-1', asset!.id)
    const replacementPath = join(sourceRoot, 'cross-volume-replacement.webp')
    await sharp(fixturePath).webp().toFile(replacementPath)
    const journalCountBeforeRelink = listPromotionJournals().length
    /** 记录重新定位原图与缩略图的跨卷提升次数。 */
    let crossVolumePromotions = 0
    service = createService({
      renameFile: (sourcePath, targetPath) => {
        if (sourcePath.startsWith(paths.stagingDir)) {
          crossVolumePromotions += 1
          throw createFileSystemError('EXDEV')
        }
        renameSync(sourcePath, targetPath)
      },
    })

    const result = await service.relinkAsset('project-1', asset!.id, replacementPath, withAsset.revision)
    const relinked = result.assets.find((item) => item.id === asset!.id)

    expect(crossVolumePromotions).toBe(2)
    expect(relinked?.mediaType).toBe('image/webp')
    expect(existsSync(oldAssetPath)).toBe(false)
    expect(existsSync(service.resolveAssetPath('project-1', asset!.id))).toBe(true)
    expect(readdirSync(paths.assetsDir).some((name) => name.includes('.proma-promote-'))).toBe(false)
    expect(listPromotionJournals()).toHaveLength(journalCountBeforeRelink)
  })

  test('Given relink 失败且目标卷临时文件无法删除 When 回滚 Then 保留原错误与 journal 供重启恢复', async () => {
    const initialBatch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = initialBatch[0]!
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    initialBatch.commit()
    const replacementPath = join(sourceRoot, 'relink-temp-cleanup.webp')
    await sharp(fixturePath).webp().toFile(replacementPath)
    const warnings: string[] = []
    service = createService({
      runtimeId: 'runtime-relink-temp-failed',
      renameFile: (sourcePath, targetPath) => {
        if (sourcePath.startsWith(paths.stagingDir)) throw createFileSystemError('EXDEV')
        if (basename(sourcePath).startsWith('.proma-promote-')) throw createFileSystemError('EIO')
        renameSync(sourcePath, targetPath)
      },
      cleanupPath: (path) => {
        if (basename(path).startsWith('.proma-promote-')) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
      warn: (message) => warnings.push(message),
    })

    await expect(service.relinkAsset('project-1', asset.id, replacementPath, withAsset.revision))
      .rejects.toThrow('EIO')
    expect(warnings.some((message) => message.includes('清理失败'))).toBe(true)
    expect(listPromotionJournals()).toHaveLength(1)
    expect(readdirSync(paths.assetsDir).some((name) => name.startsWith('.proma-promote-'))).toBe(true)

    service = createService({ runtimeId: 'runtime-relink-temp-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.assetsDir)).toEqual([basename(asset.relativePath)])
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given relink 校验失败且 staging 无法删除 When 回滚 Then 保留原错误与 journal 供重启恢复', async () => {
    const initialBatch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = initialBatch[0]!
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    initialBatch.commit()
    const invalidReplacementPath = join(sourceRoot, 'relink-staging-cleanup.png')
    writeFileSync(invalidReplacementPath, 'not an image', 'utf8')
    const warnings: string[] = []
    service = createService({
      runtimeId: 'runtime-relink-staging-failed',
      cleanupPath: (path) => {
        if (path.startsWith(paths.stagingDir)) throw createFileSystemError('EPERM')
        rmSync(path, { recursive: true, force: true })
      },
      warn: (message) => warnings.push(message),
    })

    await expect(service.relinkAsset(
      'project-1',
      asset.id,
      invalidReplacementPath,
      withAsset.revision,
    )).rejects.toThrow('不支持或损坏的图片')
    expect(warnings.some((message) => message.includes('staging 清理失败'))).toBe(true)
    expect(readdirSync(paths.stagingDir)).toHaveLength(1)
    expect(listPromotionJournals()).toHaveLength(1)

    service = createService({ runtimeId: 'runtime-relink-staging-retry' })
    service.recoverPromotionJournals('project-1')

    expect(readdirSync(paths.stagingDir)).toEqual([])
    expect(existsSync(join(paths.designRoot, asset.relativePath))).toBe(true)
    expect(listPromotionJournals()).toEqual([])
  })

  test('Given canvas JSON 已 rename 但 durability 同步失败 When 重新定位 Then 保留新 revision 引用文件', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    const replacementPath = join(sourceRoot, 'uncertain-replacement.webp')
    await sharp(fixturePath).webp().toFile(replacementPath)
    /** mutate 先真实提交新 revision，再模拟目录 durability 同步失败。 */
    const uncertainStore: DesignStore = {
      load: (projectId) => store.load(projectId),
      requireStableAuthoritativeDocument: (projectId) => (
        store.requireStableAuthoritativeDocument(projectId)
      ),
      mutate: (projectId, expectedRevision, mutations) => {
        store.mutate(projectId, expectedRevision, mutations)
        throw new Error('目录持久化同步失败')
      },
    }
    service = createService({ store: uncertainStore })

    await expect(service.relinkAsset('project-1', asset!.id, replacementPath, withAsset.revision))
      .rejects.toThrow('目录持久化同步失败')
    const persisted = store.load('project-1').document.assets.find((item) => item.id === asset!.id)

    expect(persisted?.mediaType).toBe('image/webp')
    expect(existsSync(join(paths.designRoot, persisted!.relativePath))).toBe(true)
    expect(existsSync(join(paths.cacheRoot, persisted!.thumbnailRelativePath))).toBe(true)
  })

  test('Given relink mutate 与 reload 都失败 When 提交状态未知 Then 保留新文件与 journal', async () => {
    const batch = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    const asset = batch[0]!
    const withAsset = store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset] }])
    batch.commit()
    const replacementPath = join(sourceRoot, 'unknown-replacement.webp')
    await sharp(fixturePath).webp().toFile(replacementPath)
    /** 第一次 load 用于读取旧元数据，mutate 失败后的 reload 模拟磁盘状态不可判定。 */
    let loadCount = 0
    const unknownStore: DesignStore = {
      load: (projectId) => {
        loadCount += 1
        if (loadCount === 1) return store.load(projectId)
        throw new Error('reload 失败')
      },
      requireStableAuthoritativeDocument: (projectId) => {
        loadCount += 1
        if (loadCount === 1) return store.requireStableAuthoritativeDocument(projectId)
        throw new Error('reload 失败')
      },
      mutate: () => { throw new Error('mutate 失败') },
    }
    service = createService({ store: unknownStore, runtimeId: 'runtime-unknown' })

    await expect(service.relinkAsset('project-1', asset.id, replacementPath, withAsset.revision))
      .rejects.toThrow('mutate 失败')

    expect(readdirSync(paths.assetsDir)).toHaveLength(2)
    expect(readdirSync(paths.thumbnailsDir)).toHaveLength(2)
    expect(listPromotionJournals()).toHaveLength(1)
  })

  test('Given 主进程提供导出目标 When 导出 Then 原图字节保持一致', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    const targetPath = join(sourceRoot, 'exported.png')

    await service.exportAsset('project-1', asset!.id, targetPath)

    expect(readFileSync(targetPath)).toEqual(readFileSync(service.resolveAssetPath('project-1', asset!.id)))
  })

  test('Given 素材叶子被替换为根外 symlink When 解析或导出 Then fail closed', async () => {
    const [asset] = await service.importAuthorizedFiles('project-1', [fixturePath], { kind: 'picker' })
    store.mutate('project-1', 0, [{ type: 'upsert-assets', assets: [asset!] }])
    const managedPath = join(paths.assetsDir, basename(asset!.relativePath))
    rmSync(managedPath)
    const outsidePath = join(sourceRoot, 'outside.png')
    writeFileSync(outsidePath, readFileSync(fixturePath))
    symlinkSync(outsidePath, managedPath)
    const targetPath = join(sourceRoot, 'escaped-export.png')

    expect(() => service.resolveAssetPath('project-1', asset!.id)).toThrow('素材文件不是实际普通文件')
    await expect(service.exportAsset('project-1', asset!.id, targetPath))
      .rejects.toThrow('素材文件不是实际普通文件')
    expect(existsSync(targetPath)).toBe(false)
  })

  test('Given 相对导出路径 When 导出 Then 拒绝 Renderer 风格目标路径', async () => {
    await expect(service.exportAsset('project-1', 'asset-1', 'renderer-target.png'))
      .rejects.toThrow('导出目标必须来自主进程文件选择器')
  })

  test('Given 项目有大量节点 When 创建媒体授权 Then 始终只注册两个目录且可释放', () => {
    /** 记录原子批量授权调用，确保两个目录共享一个容量事务。 */
    const registeredBatches: string[][] = []
    /** 记录释放的 opaque URL。 */
    const revoked: string[] = []
    service = new DesignAssetService({
      pathResolver: { resolve: () => paths },
      store,
      now: () => 200,
      runWorkspaceWrite: (_projectId, effect) => effect(),
      registerDirectoryPath: () => { throw new Error('不应逐个注册 Design 媒体目录') },
      registerRetainedDirectoryPaths: (directoryPaths) => {
        registeredBatches.push(directoryPaths)
        return directoryPaths.map((directoryPath) => `proma-file://${basename(directoryPath)}`)
      },
      revokePathUrl: (url) => revoked.push(url),
      warn: () => {},
    })

    const access = service.createMediaAccess('project-1')
    access.release()
    access.release()

    expect(registeredBatches).toEqual([[paths.assetsDir, paths.thumbnailsDir]])
    expect(revoked).toEqual([access.assetBaseUrl, access.thumbnailBaseUrl])
  })

  test('Given 缩略图目录授权失败 When 创建媒体授权 Then 释放已注册的原图 token', () => {
    /** 第一次注册成功、第二次注册失败的调用次数。 */
    let registrationCount = 0
    /** 失败回滚时释放的原图 token。 */
    const revoked: string[] = []
    service = new DesignAssetService({
      pathResolver: { resolve: () => paths },
      store,
      runWorkspaceWrite: (_projectId, effect) => effect(),
      registerDirectoryPath: () => {
        registrationCount += 1
        if (registrationCount === 2) throw new Error('注册失败')
        return 'proma-file://assets-token'
      },
      revokePathUrl: (url) => revoked.push(url),
      warn: () => {},
    })

    expect(() => service.createMediaAccess('project-1')).toThrow('注册失败')
    expect(revoked).toEqual(['proma-file://assets-token'])
  })

  /** 使用当前测试基础依赖创建可窄注入文件提升行为的服务。 */
  function createService(overrides: {
    renameFile?: (sourcePath: string, targetPath: string) => void
    cleanupPath?: (path: string) => void
    store?: DesignStore
    runtimeId?: string
    warn?: (message: string) => void
  }): DesignAssetService {
    return new DesignAssetService({
      pathResolver: { resolve: () => paths },
      store: overrides.store ?? store,
      now: () => 200,
      runWorkspaceWrite: (_projectId, effect) => effect(),
      registerDirectoryPath: (directoryPath) => `proma-file://${basename(directoryPath)}`,
      revokePathUrl: () => {},
      warn: overrides.warn ?? (() => {}),
      ...(overrides.renameFile || overrides.cleanupPath ? {
        filePromotion: {
          ...(overrides.renameFile ? { renameFile: overrides.renameFile } : {}),
          ...(overrides.cleanupPath ? { cleanupPath: overrides.cleanupPath } : {}),
        },
      } : {}),
      ...(overrides.runtimeId ? { runtimeId: overrides.runtimeId } : {}),
    })
  }

  /** 列出测试项目缓存中的 promotion journal。 */
  function listPromotionJournals(): string[] {
    const directoryPath = join(paths.jobsDir, 'promotions')
    return existsSync(directoryPath) ? readdirSync(directoryPath) : []
  }

  /**
   * 将当前主画布转换为指定恢复候选，模拟进程在原子替换窗口崩溃。
   * @param recoverySource 要由下一次加载消费的恢复层。
   */
  function forceCanvasRecovery(recoverySource: 'tmp' | 'backup'): void {
    if (recoverySource === 'tmp') {
      renameSync(paths.canvasPath, `${paths.canvasPath}.tmp`)
      return
    }
    writeFileSync(`${paths.canvasPath}.bak`, readFileSync(paths.canvasPath))
    writeFileSync(paths.canvasPath, '{ broken', 'utf8')
  }
})

/** 创建带稳定 code 的文件系统错误，模拟跨卷与目标提交失败。 */
function createFileSystemError(code: string): NodeJS.ErrnoException {
  const error = new Error(code) as NodeJS.ErrnoException
  error.code = code
  return error
}

/** 计算 PNG chunk 使用的 IEEE CRC-32。 */
function calculateCrc32(bytes: Buffer): number {
  /** CRC 初始值按 PNG 规范设为全 1。 */
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) === 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
