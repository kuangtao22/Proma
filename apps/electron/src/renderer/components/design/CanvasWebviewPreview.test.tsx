import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  CANVAS_WEBVIEW_DEVICE_OPTIONS,
  CanvasWebviewPreviewView,
  createCanvasWebviewFrameIdentity,
  createInitialCanvasWebviewPreviewState,
  reduceCanvasWebviewPreviewState,
  shouldStartCanvasWebviewPreviewLoad,
} from './CanvasWebviewPreview'

/** 测试使用的完整网页预览目标。 */
const desktopTarget = {
  projectId: 'project-1', canvasId: 'canvas-1', nodeId: 'webview-1',
  prototypeId: 'prototype-1', contentRevision: 2, devicePreset: 'desktop' as const,
}

describe('Canvas WebView 静态卡片预览', () => {
  test('Given 网页与手机预设 When 读取设备菜单 Then 显示明确视口尺寸', () => {
    expect(CANVAS_WEBVIEW_DEVICE_OPTIONS).toEqual([
      { value: 'desktop', label: '网页', viewportLabel: '1440 x 900' },
      { value: 'mobile', label: '手机', viewportLabel: '390 x 844' },
    ])
  })

  test('Given 旧设备请求迟到 When 当前目标已切换手机 Then 丢弃旧快照', () => {
    const mobileTarget = { ...desktopTarget, devicePreset: 'mobile' as const }
    const loading = reduceCanvasWebviewPreviewState(
      createInitialCanvasWebviewPreviewState(desktopTarget),
      { type: 'target-changed', target: mobileTarget },
    )
    const stale = reduceCanvasWebviewPreviewState(loading, {
      type: 'loaded',
      target: desktopTarget,
      snapshot: {
        target: desktopTarget,
        previewUrl: 'proma-file://preview/desktop.webp',
        width: 1440,
        height: 900,
      },
    })

    expect(stale).toEqual(loading)
  })

  test('Given 静态预览加载成功 When 渲染卡片内容 Then 图片不接收指针和拖拽', () => {
    const state = reduceCanvasWebviewPreviewState(
      createInitialCanvasWebviewPreviewState(desktopTarget),
      {
        type: 'loaded',
        target: desktopTarget,
        snapshot: {
          target: desktopTarget,
          previewUrl: 'proma-file://preview/home.webp',
          width: 1440,
          height: 900,
        },
      },
    )
    const html = renderToStaticMarkup(
      <CanvasWebviewPreviewView
        state={state}
        title="首页原型"
        statusLabel="已创建"
        onRetry={() => undefined}
        onImageError={() => undefined}
      />,
    )

    expect(html).toContain('src="proma-file://preview/home.webp"')
    expect(html).toContain('pointer-events-none')
    expect(html).toContain('draggable="false"')
    expect(html).not.toContain('<iframe')
  })

  test('Given 预览失败后重试 When 归约状态 Then 回到加载态并推进请求代次', () => {
    const failed = reduceCanvasWebviewPreviewState(
      createInitialCanvasWebviewPreviewState(desktopTarget),
      { type: 'failed', target: desktopTarget },
    )
    const retried = reduceCanvasWebviewPreviewState(failed, { type: 'retry' })

    expect(failed.phase).toBe('error')
    expect(retried).toMatchObject({ phase: 'loading', retryGeneration: 1 })
  })

  test('Given 设备预设仍在保存队列 When 卡片切到新目标 Then 等权威保存完成后才请求预览', () => {
    const mobileTarget = { ...desktopTarget, devicePreset: 'mobile' as const }
    const loading = reduceCanvasWebviewPreviewState(
      createInitialCanvasWebviewPreviewState(desktopTarget),
      { type: 'target-changed', target: mobileTarget },
    )
    const ready = reduceCanvasWebviewPreviewState(loading, {
      type: 'loaded',
      target: mobileTarget,
      snapshot: {
        target: mobileTarget,
        previewUrl: 'proma-file://preview/mobile.webp',
        width: 390,
        height: 844,
      },
    })

    expect(shouldStartCanvasWebviewPreviewLoad(loading, mobileTarget, false)).toBe(false)
    expect(shouldStartCanvasWebviewPreviewLoad(loading, mobileTarget, true)).toBe(true)
    expect(shouldStartCanvasWebviewPreviewLoad(ready, mobileTarget, true)).toBe(false)
  })

  test('Given 详情页设备预设切换 When HTML revision 不变 Then 可执行页面身份不变', () => {
    expect(createCanvasWebviewFrameIdentity(desktopTarget)).toBe(
      createCanvasWebviewFrameIdentity({ ...desktopTarget, devicePreset: 'mobile' }),
    )
  })
})
