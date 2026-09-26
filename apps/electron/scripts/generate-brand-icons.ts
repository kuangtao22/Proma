/**
 * DutyDeck 品牌图标生成器。
 *
 * 形状来自 `brand-glyph-contour.ts`：那份轮廓是从用户提供的 D 字标参考图里**描出来的**
 * （参考图 218×198，底色 #151515、字色 #F1F1F1）。参考图不是"圆环 + 矩形"的标准构造，
 * 参数化拟合始终对不准，所以这里直接按描图数据做多边形光栅化。
 *
 * 为什么自己实现光栅化与编码：旧脚本依赖 rsvg-convert 与 ImageMagick，本机都没有装，
 * 管线实际不可复现。这里只用 Node 内置模块，PNG/ICO/ICNS 全部自写，输出完全确定。
 *
 * 用法：bun run scripts/generate-brand-icons.ts
 */

import { Buffer } from 'node:buffer'
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { GLYPH_CONTOUR_PX } from './brand-glyph-contour'

/** 脚本所在的 Electron 工作区根目录。 */
const workspaceRoot = resolve(import.meta.dir, '..')
/** 需要写入图标的资源目录。 */
const resourcesDir = join(workspaceRoot, 'resources')

/**
 * 颜色：照参考图量测值——底色 #151515（不是纯黑），字形是均匀的 #F1F1F1。
 */
const TILE = '#151515'
const GLYPH = '#F1F1F1'
/** 渐变右端的颜色：纯白，比字形本色更亮一档。 */
const GLYPH_BRIGHT = '#FFFFFF'
/**
 * 字形的不透明度渐变：左端 0% → 右端 100%，右端颜色为纯白。
 *
 * 节奏参考 Proma 图标的实测值：它那六根条叠在黑底上的等效 alpha 依次是
 * 1.00 / 0.80 / 0.62 / 0.45 / 0.30 / 0.17——几乎线性（每级约 −0.17），
 * 也就是「从亮端线性压到接近 0」。这里把暗端按用户要求压到 0（完全透），
 * 于是左侧边缘自然没入背景。只改透明度与亮度、不改几何。
 */
const GLYPH_FADE_ALPHA = 0
/**
 * 渐变在整条对角线的这个比例处就已经到达纯白，之后保持全亮。
 * 数值越小、亮区越大；0.75 表示右下角约四分之一的区域是完全亮的。
 */
const BRIGHT_RAMP_END = 0.75

/** 参考图里字形包围盒（描图数据的取值范围），用于把轮廓映射到 1024 网格。 */
const CONTOUR_MIN_X = 33.9
const CONTOUR_MAX_X = 159
const CONTOUR_MIN_Y = 40.7
const CONTOUR_MAX_Y = 167.4
/**
 * 字形在 1024 画布里的宽度（单位）。
 * 底板 squircle 本身占 64..960（896 宽），所以 560 表示字形约占底板的 62.5%，
 * 四周留白更从容——用户在图标里看过之后要求再收一点（此前是 600）。
 */
const GLYPH_SIZE = 560
/** 缩放到 GLYPH_SIZE 的字身宽度，并把中心对齐到画布中心。 */
const CONTOUR_SCALE = GLYPH_SIZE / (CONTOUR_MAX_X - CONTOUR_MIN_X)
const CONTOUR_CENTER_X = (CONTOUR_MIN_X + CONTOUR_MAX_X) / 2
const CONTOUR_CENTER_Y = (CONTOUR_MIN_Y + CONTOUR_MAX_Y) / 2

/**
 * 描图轮廓映射到 1024 网格后的坐标。
 * 一个环里同时包含外轮廓与内孔（描图时它们在细颈处相连），用奇偶填充规则即可正确挖空。
 */
const GLYPH_CONTOUR: [number, number][][] = GLYPH_CONTOUR_PX.map((loop) =>
  loop.map(
    ([x, y]) =>
      [
        512 + (x - CONTOUR_CENTER_X) * CONTOUR_SCALE,
        512 + (y - CONTOUR_CENTER_Y) * CONTOUR_SCALE,
      ] as [number, number],
  ),
)

/** 字形在 1024 网格下的包围盒，用于按比例计算透明度渐变。 */
const GLYPH_LEFT = 512 + (CONTOUR_MIN_X - CONTOUR_CENTER_X) * CONTOUR_SCALE
const GLYPH_RIGHT = 512 + (CONTOUR_MAX_X - CONTOUR_CENTER_X) * CONTOUR_SCALE
const GLYPH_TOP = 512 + (CONTOUR_MIN_Y - CONTOUR_CENTER_Y) * CONTOUR_SCALE
const GLYPH_BOTTOM = 512 + (CONTOUR_MAX_Y - CONTOUR_CENTER_Y) * CONTOUR_SCALE

/** 定点颜色，避免每次解析十六进制字符串。 */
interface Color {
  /** 红通道 0–255。 */
  r: number
  /** 绿通道 0–255。 */
  g: number
  /** 蓝通道 0–255。 */
  b: number
  /** 透明度 0–1。 */
  a: number
}

/**
 * 解析 #RRGGBB 或 #RRGGBBAA 颜色。
 * @param hex 十六进制颜色字符串。
 * @returns 归一化后的颜色对象。
 */
function parseColor(hex: string): Color {
  const clean = hex.replace('#', '')
  const value = Number.parseInt(clean.slice(0, 6), 16)
  const alpha = clean.length === 8 ? Number.parseInt(clean.slice(6, 8), 16) / 255 : 1
  return { r: (value >> 16) & 0xff, g: (value >> 8) & 0xff, b: value & 0xff, a: alpha }
}

/** 圆角矩形 SDF：返回值 < 0 表示在形状内部。 */
function sdRoundedRect(
  px: number,
  py: number,
  cx: number,
  cy: number,
  halfWidth: number,
  halfHeight: number,
  radius: number,
): number {
  const dx = Math.abs(px - cx) - (halfWidth - radius)
  const dy = Math.abs(py - cy) - (halfHeight - radius)
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
  return outside + Math.min(Math.max(dx, dy), 0) - radius
}

/**
 * 把颜色按给定透明度合成到像素上。
 * @param rgba 目标缓冲区。
 * @param size 画布边长。
 * @param x 像素横坐标。
 * @param y 像素纵坐标。
 * @param color 颜色。
 * @param alpha 该像素的最终透明度（已含覆盖率）。
 */
function blend(rgba: Uint8Array, size: number, x: number, y: number, color: Color, alpha: number): void {
  if (alpha <= 0) return
  const offset = (y * size + x) * 4
  const sourceAlpha = Math.min(1, color.a * alpha)
  const targetAlpha = rgba[offset + 3] / 255
  const outAlpha = sourceAlpha + targetAlpha * (1 - sourceAlpha)
  if (outAlpha <= 0) return
  const channels = [color.r, color.g, color.b]
  for (let channel = 0; channel < 3; channel += 1) {
    rgba[offset + channel] = Math.round(
      (channels[channel] * sourceAlpha + rgba[offset + channel] * targetAlpha * (1 - sourceAlpha)) / outAlpha,
    )
  }
  rgba[offset + 3] = Math.round(outAlpha * 255)
}

/** 扫描线光栅化时的子行数量：越大边界越平滑。 */
const SUBSAMPLES = 4

/**
 * 用扫描线把字形轮廓光栅化成覆盖率图。
 *
 * 纵向用 4 条子行采样、横向按线段与像素的重叠长度解析积分，所以斜边和曲线都很平滑；
 * 采用奇偶规则（even-odd），一个环里同时含外轮廓与内孔也能正确挖空。
 *
 * @param size 输出边长（正方形）。
 * @param viewStart 可视区左上角在 1024 网格中的坐标。
 * @param viewSize 可视区边长（1024 网格单位）。
 * @returns 长度为 size×size 的覆盖率数组（0–1）。
 */
function rasterizeGlyph(size: number, viewStart: number, viewSize: number): Float32Array {
  const coverage = new Float32Array(size * size)
  /** 网格 → 输出像素的换算比例。 */
  const scale = size / viewSize
  const loops = GLYPH_CONTOUR.map((loop) =>
    loop.map(([x, y]) => [(x - viewStart) * scale, (y - viewStart) * scale] as [number, number]),
  )

  for (let py = 0; py < size; py += 1) {
    for (let sub = 0; sub < SUBSAMPLES; sub += 1) {
      const scanY = py + (sub + 0.5) / SUBSAMPLES
      /** 当前扫描线与所有边的交点。 */
      const crossings: number[] = []
      for (const loop of loops) {
        for (let index = 0; index < loop.length; index += 1) {
          const [x1, y1] = loop[index]
          const [x2, y2] = loop[(index + 1) % loop.length]
          if ((y1 <= scanY && y2 > scanY) || (y2 <= scanY && y1 > scanY)) {
            crossings.push(x1 + ((scanY - y1) / (y2 - y1)) * (x2 - x1))
          }
        }
      }
      crossings.sort((a, b) => a - b)
      for (let index = 0; index + 1 < crossings.length; index += 2) {
        const from = Math.max(0, crossings[index])
        const to = Math.min(size, crossings[index + 1])
        if (to <= from) continue
        for (let px = Math.floor(from); px < Math.ceil(to); px += 1) {
          const overlap = Math.min(to, px + 1) - Math.max(from, px)
          if (overlap > 0) coverage[py * size + px] += overlap / SUBSAMPLES
        }
      }
    }
  }
  return coverage
}

/**
 * 渲染应用图标：深灰 squircle 底板 + 字形（带从左到右的透明度渐变）。
 * @param size 输出边长。
 * @returns RGBA 像素数据。
 */
function renderAppIcon(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const scale = size / 1024
  /** 底板：先铺满 squircle。 */
  const tile = parseColor(TILE)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const distance = sdRoundedRect(x + 0.5, y + 0.5, 512 * scale, 512 * scale, 448 * scale, 448 * scale, 224 * scale)
      const alpha = Math.max(0, Math.min(1, 0.5 - distance))
      if (alpha > 0) blend(rgba, size, x, y, tile, alpha)
    }
  }

  const coverage = rasterizeGlyph(size, 0, 1024)
  const glyph = parseColor(GLYPH)
  const glyphBright = parseColor(GLYPH_BRIGHT)
  const left = GLYPH_LEFT * scale
  const right = GLYPH_RIGHT * scale
  const top = GLYPH_TOP * scale
  const bottom = GLYPH_BOTTOM * scale
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = coverage[y * size + x]
      if (cov <= 0) continue
      /**
       * 渐变比例：沿「左上 → 右下」的对角线取值。
       * 左上端 0（完全透明、没入背景），右下端 1（纯白、完全不透明）。
       */
      const horizontal = (x - left) / (right - left)
      const vertical = (y - top) / (bottom - top)
      /** 先算对角线位置，再按「提前到纯白」的比例归一：超过 BRIGHT_RAMP_END 就是全亮。 */
      const diagonal = Math.max(0, Math.min(1, (horizontal + vertical) / 2))
      const ratio = Math.max(0, Math.min(1, diagonal / BRIGHT_RAMP_END))
      /** 颜色与透明度一起过渡：左端 #F1F1F1、右端纯白。 */
      const color: Color = {
        r: Math.round(glyph.r + (glyphBright.r - glyph.r) * ratio),
        g: Math.round(glyph.g + (glyphBright.g - glyph.g) * ratio),
        b: Math.round(glyph.b + (glyphBright.b - glyph.b) * ratio),
        a: 1,
      }
      blend(rgba, size, x, y, color, (GLYPH_FADE_ALPHA + (1 - GLYPH_FADE_ALPHA) * ratio) * cov)
    }
  }
  return rgba
}

/** 缩微标记的取景：以字形为中心、四周各留约 50 单位的正方形裁切。 */
const MARK_VIEW_START = 162
const MARK_VIEW_SIZE = 700

/**
 * 渲染单色标记（托盘模板 / 启动页 / 引导页）。
 * 与图标同源，但不含底板与透明度渐变，保证小尺寸下干净可辨。
 * @param size 输出边长。
 * @param color 单色颜色。
 * @returns RGBA 像素数据。
 */
function renderMark(size: number, color: Color): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const coverage = rasterizeGlyph(size, MARK_VIEW_START, MARK_VIEW_SIZE)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const cov = coverage[y * size + x]
      if (cov > 0) blend(rgba, size, x, y, color, cov)
    }
  }
  return rgba
}

/** CRC32 查表，用于写入 PNG 数据块。 */
const crcTable = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/**
 * 计算 CRC32。
 * @param data 待校验数据。
 * @returns 无符号 32 位校验值。
 */
function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/**
 * 组装 PNG 数据块。
 * @param type 四字符块类型。
 * @param data 块内容。
 * @returns 完整块缓冲区。
 */
function pngChunk(type: string, data: Uint8Array): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/**
 * 把 RGBA 缓冲区编码为 PNG。
 * @param size 画布边长。
 * @param rgba 像素数据。
 * @returns PNG 文件内容。
 */
function encodePng(size: number, rgba: Uint8Array): Buffer {
  const stride = size * 4
  const raw = Buffer.alloc((stride + 1) * size)
  for (let y = 0; y < size; y += 1) {
    raw[y * (stride + 1)] = 0
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

/**
 * 组装 Windows .ico（内嵌 PNG 条目，Vista 及以上支持）。
 * @param entries 尺寸与对应 PNG 数据，按尺寸升序。
 * @returns ico 文件内容。
 */
function encodeIco(entries: { size: number; png: Buffer }[]): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(entries.length, 4)
  const directory = Buffer.alloc(entries.length * 16)
  let offset = 6 + entries.length * 16
  entries.forEach((entry, index) => {
    const base = index * 16
    directory[base] = entry.size >= 256 ? 0 : entry.size
    directory[base + 1] = entry.size >= 256 ? 0 : entry.size
    directory[base + 2] = 0
    directory[base + 3] = 0
    directory.writeUInt16LE(1, base + 4)
    directory.writeUInt16LE(32, base + 6)
    directory.writeUInt32LE(entry.png.length, base + 8)
    directory.writeUInt32LE(offset, base + 12)
    offset += entry.png.length
  })
  return Buffer.concat([header, directory, ...entries.map((entry) => entry.png)])
}

/**
 * 组装 macOS .icns（PNG 型数据块，10.7 起支持）。
 *
 * 为什么不用 iconutil：本机（macOS 26）iconutil 对任何输入都返回 `Invalid Iconset`，
 * 连系统 PNG 也复现，属于环境不可用；自行写容器可以做到零外部依赖且输出确定。
 *
 * @param entries ICNS 类型与对应 PNG 数据。
 * @returns icns 文件内容。
 */
function encodeIcns(entries: { type: string; png: Buffer }[]): Buffer {
  const chunks = entries.map((entry) => {
    const header = Buffer.alloc(8)
    header.write(entry.type, 0, 'ascii')
    header.writeUInt32BE(entry.png.length + 8, 4)
    return Buffer.concat([header, entry.png])
  })
  const total = 8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 'ascii')
  header.writeUInt32BE(total, 4)
  return Buffer.concat([header, ...chunks])
}

/**
 * 生成字形的 SVG 路径数据。
 * @param originX 网格取景的左上角横坐标（用于缩微标记）。
 * @param originY 网格取景的左上角纵坐标。
 */
function glyphPathData(originX = 0, originY = 0): string {
  return GLYPH_CONTOUR.map((loop) => {
    const commands = loop.map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${(x - originX).toFixed(1)} ${(y - originY).toFixed(1)}`)
    return `${commands.join(' ')} Z`
  }).join(' ')
}

/**
 * 生成应用图标的 SVG 源文件：squircle 底板 + 带透明度渐变的字形。
 */
function buildIconSvg(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 scripts/generate-brand-icons.ts 生成，请勿手改：几何来自 brand-glyph-contour.ts 的描图数据。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <defs>
    <linearGradient id="glyph" gradientUnits="userSpaceOnUse" x1="${GLYPH_LEFT.toFixed(1)}" y1="${GLYPH_TOP.toFixed(1)}" x2="${GLYPH_RIGHT.toFixed(1)}" y2="${GLYPH_BOTTOM.toFixed(1)}">
      <stop offset="0" stop-color="${GLYPH}" stop-opacity="${GLYPH_FADE_ALPHA}"/>
      <stop offset="${BRIGHT_RAMP_END}" stop-color="${GLYPH_BRIGHT}"/>
      <stop offset="1" stop-color="${GLYPH_BRIGHT}"/>
    </linearGradient>
  </defs>
  <rect x="64" y="64" width="896" height="896" rx="224" fill="${TILE}"/>
  <path fill-rule="evenodd" fill="url(#glyph)" d="${glyphPathData()}"/>
</svg>
`
}

/**
 * 生成单色标记的 SVG 源文件（托盘模板 / 启动页 / 引导页共用）。
 * @param color 单色颜色。
 */
function buildMarkSvg(color: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- 由 scripts/generate-brand-icons.ts 生成，请勿手改：几何来自 brand-glyph-contour.ts 的描图数据。 -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MARK_VIEW_SIZE} ${MARK_VIEW_SIZE}" width="${MARK_VIEW_SIZE}" height="${MARK_VIEW_SIZE}">
  <path fill-rule="evenodd" fill="${color}" d="${glyphPathData(MARK_VIEW_START, MARK_VIEW_START)}"/>
</svg>
`
}

/**
 * 写入单个文件并创建父目录。
 * @param path 目标路径。
 * @param content 文件内容。
 */
function write(path: string, content: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
  console.log(`  ✓ ${path.replace(`${workspaceRoot}/`, '')}`)
}

console.log('🎨 生成 DutyDeck 品牌图标…')

/** 主图标尺寸，macOS/Linux 使用 1024 源图缩小。 */
const iconSizes = [16, 32, 48, 64, 128, 256, 512, 1024]
const appIconPngs = iconSizes.map((size) => ({ size, png: encodePng(size, renderAppIcon(size)) }))

write(join(resourcesDir, 'icon.png'), appIconPngs.find((entry) => entry.size === 1024)!.png)
write(
  join(resourcesDir, 'icon.ico'),
  encodeIco(appIconPngs.filter((entry) => entry.size <= 256)),
)

/** macOS .icns：把 PNG 按官方类型编号装进容器。 */
const icnsEntries = [
  { type: 'icp4', size: 16 },
  { type: 'icp5', size: 32 },
  { type: 'icp6', size: 64 },
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic13', size: 256 },
  { type: 'ic08', size: 256 },
  { type: 'ic14', size: 512 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
].map((entry) => ({
  type: entry.type,
  png: appIconPngs.find((candidate) => candidate.size === entry.size)!.png,
}))
write(join(resourcesDir, 'icon.icns'), encodeIcns(icnsEntries))

/** 托盘模板图标：22pt / 44px / 66px，黑色 + alpha。 */
const trayDir = join(resourcesDir, 'dutydeck-logos')
const trayColor = parseColor('#000000')
write(join(trayDir, 'iconTemplate.png'), encodePng(22, renderMark(22, trayColor)))
write(join(trayDir, 'iconTemplate@2x.png'), encodePng(44, renderMark(44, trayColor)))
write(join(trayDir, 'iconTemplate@3x.png'), encodePng(66, renderMark(66, trayColor)))

/** 白色标记：启动页与引导页使用；同时输出 PNG（运行时用）与 SVG（源文件与文档用）。 */
const whiteMark = parseColor('#FFFFFF')
write(join(resourcesDir, 'startup-splash/dutydeck-mark-white.png'), encodePng(256, renderMark(256, whiteMark)))
write(join(workspaceRoot, 'src/renderer/assets/onboarding/dutydeck-mark-white.png'), encodePng(256, renderMark(256, whiteMark)))
/** 应用内启动屏用带底板的图标，与原生启动页保持同一张脸。 */
write(join(workspaceRoot, 'src/renderer/assets/brand/dutydeck-icon.png'), encodePng(256, renderAppIcon(256)))

/** 矢量源文件：与应用图标、托盘标记完全同源，避免 SVG 与 PNG 各写一套。 */
write(join(resourcesDir, 'icon.svg'), buildIconSvg())
write(join(trayDir, 'icon.svg'), buildMarkSvg('#000000'))
write(join(resourcesDir, 'startup-splash/dutydeck-mark-white.svg'), buildMarkSvg('#FFFFFF'))

console.log('✅ 完成')
