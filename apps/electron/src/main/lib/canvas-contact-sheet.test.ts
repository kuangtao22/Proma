import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'

const contactSheetScriptPath = join(
  import.meta.dir,
  '../../../default-skills/canvas-production/scripts/contact_sheet.py',
)

/** 外部 Python 进程的硬超时，防止异常环境令测试进程长期挂起。 */
const CLI_PROCESS_TIMEOUT_MS = 10_000
/** 并发构建负载下真实 CLI 用例允许的总执行时间。 */
const REAL_CLI_TEST_TIMEOUT_MS = 30_000

/** Python 与 Pillow 都可用时才执行真实 CLI 集成测试。 */
const pythonProbe = spawnSync('python3', ['-c', 'from PIL import Image'], {
  encoding: 'utf8',
  timeout: CLI_PROCESS_TIMEOUT_MS,
})
const realContactSheetTest = test.skipIf(pythonProbe.status !== 0)

interface ContactSheetFrameResult {
  input: string
  originalWidth: number
  originalHeight: number
  encodedWidth: number
  encodedHeight: number
  scaledWidth: number
  scaledHeight: number
  x: number
  y: number
  exifTransposed: boolean
}

interface ContactSheetResult {
  output: string
  canvasWidth: number
  canvasHeight: number
  columns: number
  rows: number
  cellWidth: number
  cellHeight: number
  frames: ContactSheetFrameResult[]
}

interface CommandResult {
  status: number | null
  stdout: string
  stderr: string
}

/** 运行随 Skill 分发的真实 CLI，保留退出码及标准输出供合同断言。 */
function runContactSheet(output: string, inputs: string[], options: string[] = []): CommandResult {
  const result = spawnSync(
    'python3',
    [contactSheetScriptPath, '--output', output, ...options, ...inputs],
    { encoding: 'utf8', maxBuffer: 1024 * 1024, timeout: CLI_PROCESS_TIMEOUT_MS },
  )
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

/** 创建颜色单一的 PNG，便于精确验证 contain 缩放后的内容与留白位置。 */
async function createSolidPng(
  path: string,
  width: number,
  height: number,
  background: { r: number; g: number; b: number },
): Promise<void> {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background,
    },
  }).png().toFile(path)
}

/** 返回指定像素的 RGBA 通道，验证图片区域没有被裁剪或铺满拉伸。 */
function readPixel(
  pixels: Buffer,
  imageWidth: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const offset = ((y * imageWidth) + x) * 4
  return [pixels[offset]!, pixels[offset + 1]!, pixels[offset + 2]!, pixels[offset + 3]!]
}

describe('Canvas 等比例联系表 CLI', () => {
  /** 每个用例独占的图片与输出目录。 */
  let fixtureRoot: string

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'proma-contact-sheet-'))
  })

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true })
  })

  realContactSheetTest('Given 竖版帧 When 缺省格高生成联系表 Then 按首帧方向比例推导且不拉伸', async () => {
    const firstPath = join(fixtureRoot, 'first.png')
    const secondPath = join(fixtureRoot, 'second.png')
    const outputPath = join(fixtureRoot, 'vertical-sheet.png')
    await createSolidPng(firstPath, 60, 120, { r: 255, g: 0, b: 0 })
    await createSolidPng(secondPath, 120, 240, { r: 0, g: 255, b: 0 })

    const command = runContactSheet(outputPath, [firstPath, secondPath])

    expect(command.status, command.stderr).toBe(0)
    const result = JSON.parse(command.stdout) as ContactSheetResult
    expect(result).toMatchObject({
      canvasWidth: 960,
      canvasHeight: 960,
      columns: 2,
      rows: 1,
      cellWidth: 480,
      cellHeight: 960,
    })
    expect(result.frames.map(frame => ({
      originalWidth: frame.originalWidth,
      originalHeight: frame.originalHeight,
      scaledWidth: frame.scaledWidth,
      scaledHeight: frame.scaledHeight,
      x: frame.x,
      y: frame.y,
    }))).toEqual([
      { originalWidth: 60, originalHeight: 120, scaledWidth: 480, scaledHeight: 960, x: 0, y: 0 },
      { originalWidth: 120, originalHeight: 240, scaledWidth: 480, scaledHeight: 960, x: 480, y: 0 },
    ])
    expect(await sharp(outputPath).metadata()).toMatchObject({ width: 960, height: 960, format: 'png' })
  }, REAL_CLI_TEST_TIMEOUT_MS)

  realContactSheetTest('Given 横竖混合帧 When 指定统一格高 Then contain 居中留白且不裁剪', async () => {
    const portraitPath = join(fixtureRoot, 'portrait.png')
    const landscapePath = join(fixtureRoot, 'landscape.png')
    const outputPath = join(fixtureRoot, 'mixed-sheet.png')
    await createSolidPng(portraitPath, 60, 120, { r: 255, g: 0, b: 0 })
    await createSolidPng(landscapePath, 120, 60, { r: 0, g: 0, b: 255 })

    const command = runContactSheet(
      outputPath,
      [portraitPath, landscapePath],
      ['--cell-width', '120', '--cell-height', '120'],
    )

    expect(command.status, command.stderr).toBe(0)
    const result = JSON.parse(command.stdout) as ContactSheetResult
    expect(result.frames.map(frame => ({
      scaledWidth: frame.scaledWidth,
      scaledHeight: frame.scaledHeight,
      x: frame.x,
      y: frame.y,
    }))).toEqual([
      { scaledWidth: 60, scaledHeight: 120, x: 30, y: 0 },
      { scaledWidth: 120, scaledHeight: 60, x: 120, y: 30 },
    ])
    const { data: pixels, info } = await sharp(outputPath)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })
    expect(readPixel(pixels, info.width, 0, 60)).toEqual([255, 255, 255, 255])
    expect(readPixel(pixels, info.width, 30, 60)).toEqual([255, 0, 0, 255])
    expect(readPixel(pixels, info.width, 180, 0)).toEqual([255, 255, 255, 255])
    expect(readPixel(pixels, info.width, 180, 30)).toEqual([0, 0, 255, 255])
  }, REAL_CLI_TEST_TIMEOUT_MS)

  realContactSheetTest('Given 带 EXIF 方向的 JPEG When 推导格高 Then 先转正再计算比例与输出位置', async () => {
    const orientedPath = join(fixtureRoot, 'oriented.jpg')
    const outputPath = join(fixtureRoot, 'oriented-sheet.png')
    await sharp({
      create: {
        width: 40,
        height: 20,
        channels: 3,
        background: { r: 40, g: 80, b: 120 },
      },
    }).jpeg().withMetadata({ orientation: 6 }).toFile(orientedPath)

    const command = runContactSheet(outputPath, [orientedPath])

    expect(command.status, command.stderr).toBe(0)
    const result = JSON.parse(command.stdout) as ContactSheetResult
    expect(result).toMatchObject({ canvasWidth: 480, canvasHeight: 960, cellHeight: 960 })
    expect(result.frames[0]).toMatchObject({
      encodedWidth: 40,
      encodedHeight: 20,
      originalWidth: 20,
      originalHeight: 40,
      scaledWidth: 480,
      scaledHeight: 960,
      exifTransposed: true,
    })
  }, REAL_CLI_TEST_TIMEOUT_MS)

  realContactSheetTest('Given 输出已存在或指向输入 When 运行 Then 拒绝覆盖并保持原文件不变', async () => {
    const inputPath = join(fixtureRoot, 'input.png')
    const outputPath = join(fixtureRoot, 'existing.png')
    await createSolidPng(inputPath, 40, 80, { r: 255, g: 0, b: 0 })
    writeFileSync(outputPath, 'sentinel')

    const existingCommand = runContactSheet(outputPath, [inputPath])
    expect(existingCommand.status).not.toBe(0)
    expect(existingCommand.stderr).toContain('输出文件已存在')
    expect(readFileSync(outputPath, 'utf8')).toBe('sentinel')

    const inputCommand = runContactSheet(inputPath, [inputPath])
    expect(inputCommand.status).not.toBe(0)
    expect(inputCommand.stderr).toContain('输出文件已存在')
    expect(await sharp(inputPath).metadata()).toMatchObject({ width: 40, height: 80 })
  }, REAL_CLI_TEST_TIMEOUT_MS)

  realContactSheetTest('Given 输出路径是悬空符号链接 When 运行 Then 拒绝且链接与目标都不变', async () => {
    const inputPath = join(fixtureRoot, 'input.png')
    const targetPath = join(fixtureRoot, 'missing-target.png')
    const outputPath = join(fixtureRoot, 'dangling-output.png')
    await createSolidPng(inputPath, 40, 80, { r: 255, g: 0, b: 0 })
    symlinkSync(targetPath, outputPath)

    const command = runContactSheet(outputPath, [inputPath])

    expect(command.status).not.toBe(0)
    expect(command.stderr).toContain('输出文件已存在')
    expect(lstatSync(outputPath).isSymbolicLink()).toBe(true)
    expect(readlinkSync(outputPath)).toBe(targetPath)
    expect(existsSync(targetPath)).toBe(false)
  }, REAL_CLI_TEST_TIMEOUT_MS)

  realContactSheetTest('Given 画布像素超预算或中途输入损坏 When 运行 Then 失败且不遗留输出和临时文件', async () => {
    const inputPath = join(fixtureRoot, 'input.png')
    const invalidPath = join(fixtureRoot, 'invalid.png')
    const oversizedOutputPath = join(fixtureRoot, 'oversized.png')
    const invalidOutputPath = join(fixtureRoot, 'invalid-output.png')
    await createSolidPng(inputPath, 40, 80, { r: 255, g: 0, b: 0 })
    writeFileSync(invalidPath, 'not-an-image')

    const oversizedCommand = runContactSheet(
      oversizedOutputPath,
      Array.from({ length: 8 }, () => inputPath),
      ['--columns', '2', '--cell-width', '2048', '--cell-height', '2048'],
    )
    expect(oversizedCommand.status).not.toBe(0)
    expect(oversizedCommand.stderr).toContain('画布像素预算')
    expect(existsSync(oversizedOutputPath)).toBe(false)

    const invalidCommand = runContactSheet(invalidOutputPath, [inputPath, invalidPath])
    expect(invalidCommand.status).not.toBe(0)
    expect(invalidCommand.stderr).toContain('无法读取图片')
    expect(existsSync(invalidOutputPath)).toBe(false)
    expect(readdirSync(fixtureRoot).some(name => name.includes('.tmp'))).toBe(false)
  }, REAL_CLI_TEST_TIMEOUT_MS)
})
