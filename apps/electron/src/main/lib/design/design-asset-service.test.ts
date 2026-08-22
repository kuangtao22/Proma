import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { DesignAssetService } from './design-asset-service'

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
    /** 记录目录级授权和释放次数，确保不会按节点注册。 */
    const registered: string[] = []
    /** 记录释放的 opaque URL。 */
    const revoked: string[] = []
    service = new DesignAssetService({
      pathResolver: { resolve: () => paths },
      store,
      now: () => 200,
      runWorkspaceWrite: (_projectId, effect) => effect(),
      registerDirectoryPath: (directoryPath) => {
        registered.push(directoryPath)
        return `proma-file://${basename(directoryPath)}`
      },
      revokePathUrl: (url) => revoked.push(url),
      warn: () => {},
    })

    const access = service.createMediaAccess('project-1')
    access.release()
    access.release()

    expect(registered).toEqual([paths.assetsDir, paths.thumbnailsDir])
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
})

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
