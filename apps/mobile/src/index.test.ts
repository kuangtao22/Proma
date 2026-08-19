import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** 手机端全局样式文本，用于锁定与桌面一致的语义主题边界。 */
const stylesheet = readFileSync(join(import.meta.dir, 'index.css'), 'utf8')

/** 从主题 CSS 块读取 HSL 三元组。 */
function readHslToken(theme: string, token: string): [number, number, number] {
  /** 主题变量只接受桌面语义色使用的 H S% L% 格式。 */
  const match = theme.match(new RegExp(`${token}:\\s*([\\d.]+)\\s+([\\d.]+)%\\s+([\\d.]+)%`))
  if (!match) throw new Error(`缺少主题变量 ${token}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/** 将 HSL 颜色转换为 sRGB 分量。 */
function hslToRgb([hue, saturationPercent, lightnessPercent]: [number, number, number]): [number, number, number] {
  /** 归一化饱和度与亮度，便于执行标准 HSL 转换。 */
  const saturation = saturationPercent / 100
  const lightness = lightnessPercent / 100
  /** HSL 转换使用的色度与中间分量。 */
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const hueSegment = hue / 60
  const intermediate = chroma * (1 - Math.abs((hueSegment % 2) - 1))
  /** 色相区间对应的临时 RGB 分量。 */
  const [red, green, blue] = hueSegment < 1 ? [chroma, intermediate, 0]
    : hueSegment < 2 ? [intermediate, chroma, 0]
      : hueSegment < 3 ? [0, chroma, intermediate]
        : hueSegment < 4 ? [0, intermediate, chroma]
          : hueSegment < 5 ? [intermediate, 0, chroma]
            : [chroma, 0, intermediate]
  /** 亮度偏移使临时分量落入最终 sRGB 区间。 */
  const offset = lightness - chroma / 2
  return [red + offset, green + offset, blue + offset]
}

/** 计算 WCAG 使用的相对亮度。 */
function relativeLuminance(rgb: [number, number, number]): number {
  /** 将 sRGB 分量线性化后按视觉权重合成亮度。 */
  const linear = rgb.map(channel => (
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  )) as [number, number, number]
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
}

/** 计算两种颜色的 WCAG 对比度。 */
function contrastRatio(foreground: [number, number, number], background: [number, number, number]): number {
  /** 对比公式要求较亮颜色位于分子。 */
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

describe('移动端主题契约', () => {
  test('Given 默认主题 When 读取样式 Then 提供完整浅色语义表面', () => {
    /** 页面组件允许依赖的核心语义变量。 */
    const requiredTokens = [
      '--background:',
      '--foreground:',
      '--content-area:',
      '--sidebar-surface:',
      '--sidebar-control-surface:',
      '--input-surface:',
      '--card:',
      '--popover:',
      '--destructive:',
      '--radius: 0.375rem;',
    ]

    for (const token of requiredTokens) expect(stylesheet).toContain(token)
    expect(stylesheet).toContain('color-scheme: light dark')
  })

  test('Given 系统深色 When 媒体查询生效 Then 覆盖核心语义表面', () => {
    /** 深色媒体查询块必须独立覆盖主要表面，避免依赖 React 状态。 */
    const darkTheme = stylesheet.match(
      /@media \(prefers-color-scheme: dark\) \{([\s\S]*?)\n\}/,
    )?.[1] ?? ''
    /** 深色模式必须重设的关键层级。 */
    const darkTokens = [
      '--background:',
      '--content-area:',
      '--sidebar-surface:',
      '--input-surface:',
      '--popover:',
    ]

    for (const token of darkTokens) expect(darkTheme).toContain(token)
  })

  test('Given 横向工作区和关键错误文本 When 使用全局主题 Then 手势与对比度满足手机可访问性', () => {
    /** 默认浅色根主题。 */
    const lightTheme = stylesheet.match(/:root \{([\s\S]*?)\n\}/)?.[1] ?? ''
    /** 系统深色媒体查询中的根主题。 */
    const darkTheme = stylesheet.match(
      /@media \(prefers-color-scheme: dark\) \{\s*:root \{([\s\S]*?)\n\s*\}/,
    )?.[1] ?? ''
    /** 浅色错误文字与页面背景。 */
    const lightContrast = contrastRatio(
      hslToRgb(readHslToken(lightTheme, '--destructive')),
      hslToRgb(readHslToken(lightTheme, '--background')),
    )
    /** 深色错误文字与侧栏背景，覆盖断开按钮的最弱场景。 */
    const darkContrast = contrastRatio(
      hslToRgb(readHslToken(darkTheme, '--destructive')),
      hslToRgb(readHslToken(darkTheme, '--sidebar-surface')),
    )

    expect(stylesheet).toContain('touch-action: manipulation')
    expect(lightContrast).toBeGreaterThanOrEqual(4.5)
    expect(darkContrast).toBeGreaterThanOrEqual(4.5)
  })
})
