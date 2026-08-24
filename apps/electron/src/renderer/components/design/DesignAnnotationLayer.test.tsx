import { describe, expect, test } from 'bun:test'
import type { DesignAnnotation, DesignPoint } from '@proma/shared'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  DesignAnnotationLayer,
  createAnnotationGestureController,
  createMaskPointBatcher,
} from './DesignAnnotationLayer'

describe('Design 箭头批注', () => {
  test('Given pointerdown 和 pointerup 两点距离至少 4px When 完成箭头 Then 创建单个两点批注', () => {
    /** 收集控制器创建的批注。 */
    const annotations: DesignAnnotation[] = []
    /** 箭头手势控制器使用调用方提供的稳定身份。 */
    const controller = createAnnotationGestureController({
      tool: 'arrow',
      color: 'hsl(var(--destructive))',
      createIdentity: () => ({ id: 'arrow-1', createdAt: 100 }),
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      onDraftChange: () => undefined,
      onCreate: (annotation) => { annotations.push(annotation) },
    })

    controller.pointerDown({ x: 1, y: 2 })
    controller.pointerUp({ x: 4, y: 6 })

    expect(annotations).toEqual([{
      id: 'arrow-1',
      kind: 'arrow',
      from: { x: 1, y: 2 },
      to: { x: 4, y: 6 },
      color: 'hsl(var(--destructive))',
      width: 12,
      createdAt: 100,
    }])
  })

  test('Given 箭头长度小于 4px When pointerup Then 不创建批注', () => {
    /** 记录不应发生的创建次数。 */
    let createCount = 0
    /** 短箭头手势控制器。 */
    const controller = createAnnotationGestureController({
      tool: 'arrow',
      color: 'hsl(var(--destructive))',
      createIdentity: () => ({ id: 'arrow-short', createdAt: 100 }),
      requestFrame: () => 1,
      cancelFrame: () => undefined,
      onDraftChange: () => undefined,
      onCreate: () => { createCount += 1 },
    })

    controller.pointerDown({ x: 0, y: 0 })
    controller.pointerUp({ x: 2, y: 2 })

    expect(createCount).toBe(0)
  })
})

describe('Design 蒙版批注', () => {
  test('Given 同一帧连续 pointermove When rAF flush Then 只批次一次并去除相邻距离小于 1px 的点', () => {
    /** 人工保存待执行 animation frame。 */
    const frames: FrameRequestCallback[] = []
    /** 收集每帧提交的去噪点批次。 */
    const flushes: DesignPoint[][] = []
    /** 使用可控 scheduler 的真实批处理器。 */
    const batcher = createMaskPointBatcher({
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => undefined,
      onFlush: (points) => { flushes.push(points) },
    })

    batcher.push({ x: 0, y: 0 })
    batcher.push({ x: 0.5, y: 0.5 })
    batcher.push({ x: 2, y: 0 })
    batcher.push({ x: 2.25, y: 0.25 })

    expect(frames).toHaveLength(1)
    frames[0]?.(16)
    expect(flushes).toEqual([[{ x: 0, y: 0 }, { x: 2, y: 0 }]])
  })

  test('Given mask 手势跨一帧移动 When pointerup Then 只创建一个默认宽度蒙版', () => {
    /** 人工保存待执行 animation frame。 */
    const frames: FrameRequestCallback[] = []
    /** 收集草稿更新。 */
    const drafts: DesignPoint[][] = []
    /** 收集最终批注。 */
    const annotations: DesignAnnotation[] = []
    /** 蒙版手势控制器。 */
    const controller = createAnnotationGestureController({
      tool: 'mask',
      color: 'hsl(var(--accent-foreground))',
      createIdentity: () => ({ id: 'mask-1', createdAt: 200 }),
      requestFrame: (callback) => {
        frames.push(callback)
        return frames.length
      },
      cancelFrame: () => undefined,
      onDraftChange: (points) => { drafts.push(points) },
      onCreate: (annotation) => { annotations.push(annotation) },
    })

    controller.pointerDown({ x: 0, y: 0 })
    controller.pointerMove({ x: 0.5, y: 0.5 })
    controller.pointerMove({ x: 2, y: 0 })
    expect(frames).toHaveLength(1)
    frames[0]?.(16)
    controller.pointerUp({ x: 4, y: 0 })

    expect(drafts.at(-1)).toEqual([])
    expect(annotations).toEqual([{
      id: 'mask-1',
      kind: 'mask',
      points: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 0 }],
      color: 'hsl(var(--accent-foreground))',
      width: 12,
      createdAt: 200,
    }])
  })
})

describe('Design 批注层交互范围', () => {
  test('Given select 或 pan 工具 When 渲染 Then 批注层不捕获 pointer', () => {
    /** 公共的无操作回调。 */
    const noop = () => undefined
    /** 选择模式静态标记。 */
    const selectHtml = renderToStaticMarkup(
      <DesignAnnotationLayer
        annotations={[]}
        activeTool="select"
        writable
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onDraftChange={noop}
        onCreate={noop}
        createIdentity={() => ({ id: 'unused', createdAt: 0 })}
      />,
    )
    /** 平移模式静态标记。 */
    const panHtml = renderToStaticMarkup(
      <DesignAnnotationLayer
        annotations={[]}
        activeTool="pan"
        writable
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onDraftChange={noop}
        onCreate={noop}
        createIdentity={() => ({ id: 'unused', createdAt: 0 })}
      />,
    )

    expect(selectHtml).toContain('pointer-events-none')
    expect(panHtml).toContain('pointer-events-none')
  })

  test('Given arrow 或 mask 工具 When 渲染 Then 使用主题语义色并捕获 pointer', () => {
    /** 公共的无操作回调。 */
    const noop = () => undefined
    /** 箭头模式静态标记。 */
    const arrowHtml = renderToStaticMarkup(
      <DesignAnnotationLayer
        annotations={[]}
        activeTool="arrow"
        writable
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onDraftChange={noop}
        onCreate={noop}
        createIdentity={() => ({ id: 'unused', createdAt: 0 })}
      />,
    )
    /** 蒙版模式静态标记。 */
    const maskHtml = renderToStaticMarkup(
      <DesignAnnotationLayer
        annotations={[]}
        activeTool="mask"
        writable
        viewport={{ x: 0, y: 0, zoom: 1 }}
        onDraftChange={noop}
        onCreate={noop}
        createIdentity={() => ({ id: 'unused', createdAt: 0 })}
      />,
    )

    expect(arrowHtml).toContain('pointer-events-auto')
    expect(arrowHtml).toContain('hsl(var(--destructive))')
    expect(arrowHtml).toContain('fill="context-stroke"')
    expect(maskHtml).toContain('pointer-events-auto')
    expect(maskHtml).toContain('hsl(var(--accent-foreground))')
  })
})
