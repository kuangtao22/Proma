import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createStableDirectoryNativeHost } from '../stable-directory-native-host'
import type { StableDirectoryNativeRequest, StableDirectoryOpenedRoot } from '../stable-directory-native-host'

/** 每个原生协议场景独占目录，避免残留目标影响覆盖语义。 */
const roots: string[] = []
/** 测试直接使用本轮构建的 helper，避免 Bun 环境缺少 Electron app。 */
const helperPath = resolve(import.meta.dir, '../../../../resources/stable-directory/stable-directory-helper')
const host = createStableDirectoryNativeHost()

/** 使用固定 helper 路径执行真实两阶段协议。 */
function runNative(
  request: StableDirectoryNativeRequest,
  authorize: (opened: readonly StableDirectoryOpenedRoot[]) => boolean,
) {
  return host.run(request, authorize, { helperPath: () => helperPath })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** 创建真实 helper 测试根。 */
function createRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'proma-artifact-export-native-'))
  roots.push(root)
  return root
}

describe('Canvas Artifact Export Native', () => {
  test('Given 两个实例竞争同一导出 operation When 原子 claim Then 只有首个创建且可精确读取', async () => {
    const root = createRoot()
    mkdirSync(join(root, 'transactions'))
    const fileName = 'artifact-export-11111111-1111-4111-8111-111111111111.json'
    const first = await runNative({
      mode: 'canvas-intent-write', roots: [root], childName: 'transactions', fileName,
      content: '{"state":"selecting"}', createOnly: true,
    }, () => true)
    const second = await runNative({
      mode: 'canvas-intent-write', roots: [root], childName: 'transactions', fileName,
      content: '{"state":"prepared"}', createOnly: true,
    }, () => true)
    const loaded = await runNative({
      mode: 'canvas-intent-read', roots: [root], childName: 'transactions', fileName,
    }, () => true)

    expect(first.writeOutcome).toEqual({ commitVisible: true, durabilityUncertain: false })
    expect(second.writeOutcome).toMatchObject({ commitVisible: false, error: 'canvas intent destination exists' })
    expect(loaded.readOutcome).toMatchObject({ status: 'ok', content: '{"state":"selecting"}' })
  })

  test('Given 目标不存在 When 原子写文本 Then 提交可见且 overwrite=false 不替换同名文件', async () => {
    const root = createRoot()
    const targetPath = join(root, 'artifact.md')
    const first = await runNative({
      mode: 'artifact-export-write', roots: [root], artifactFileName: 'artifact.md',
      content: '# 第一版', overwrite: false,
    }, () => true)

    expect(first.writeOutcome).toEqual({ commitVisible: true, durabilityUncertain: false })
    expect(readFileSync(targetPath, 'utf8')).toBe('# 第一版')

    const second = await runNative({
      mode: 'artifact-export-write', roots: [root], artifactFileName: 'artifact.md',
      content: '# 第二版', overwrite: false,
    }, () => true)
    expect(second.writeOutcome).toMatchObject({ commitVisible: false, error: 'artifact export destination exists' })
    expect(readFileSync(targetPath, 'utf8')).toBe('# 第一版')
  })

  test('Given 受管图片源 When 分块复制 Then SHA-256 匹配才提交目标', async () => {
    const root = createRoot()
    const sourcePath = join(root, 'source.png')
    const destination = join(root, 'destination')
    mkdirSync(destination)
    const bytes = Buffer.alloc(1024 * 1024 + 17, 0x5a)
    writeFileSync(sourcePath, bytes)
    const sha256 = createHash('sha256').update(bytes).digest('hex')

    const result = await runNative({
      mode: 'artifact-export-copy', roots: [sourcePath, destination], artifactFileName: 'copy.png',
      expectedSourceSize: bytes.byteLength, expectedSourceSha256: sha256, overwrite: false,
    }, () => true)
    expect(result.writeOutcome).toEqual({ commitVisible: true, durabilityUncertain: false })
    expect(readFileSync(join(destination, 'copy.png'))).toEqual(bytes)

    const rejected = await runNative({
      mode: 'artifact-export-copy', roots: [sourcePath, destination], artifactFileName: 'bad.png',
      expectedSourceSize: bytes.byteLength, expectedSourceSha256: '0'.repeat(64), overwrite: false,
    }, () => true)
    expect(rejected.writeOutcome).toMatchObject({ commitVisible: false })
    expect(existsSync(join(destination, 'bad.png'))).toBe(false)
  })

  test('Given OPENED 后目标路径被目录替换 When helper 提交 Then 只写已授权目录对象', async () => {
    const root = createRoot()
    const destination = join(root, 'destination')
    const moved = join(root, 'destination-moved')
    mkdirSync(destination)
    const result = await runNative({
      mode: 'artifact-export-write', roots: [destination], artifactFileName: 'stable.md',
      content: 'stable', overwrite: false,
    }, () => {
      renameSync(destination, moved)
      mkdirSync(destination)
      return true
    })

    expect(result.writeOutcome?.commitVisible).toBe(true)
    expect(readFileSync(join(moved, 'stable.md'), 'utf8')).toBe('stable')
    expect(existsSync(join(destination, 'stable.md'))).toBe(false)
  })
})
