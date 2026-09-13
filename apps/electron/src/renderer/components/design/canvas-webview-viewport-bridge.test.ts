import { describe, expect, test } from 'bun:test'
import {
  CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE,
  createCanvasWebviewViewportPortWheelEventInit,
  type CanvasWebviewViewportFrameMetrics,
} from './canvas-webview-viewport-bridge'

/** 构造 iframe 当前内容尺寸与缩放后屏幕矩形。 */
function createFrameMetrics(): CanvasWebviewViewportFrameMetrics {
  return {
    left: 100,
    top: 50,
    width: 400,
    height: 300,
    contentWidth: 800,
    contentHeight: 600,
  }
}

describe('Canvas WebView 视口桥', () => {
  test('Given 私有端口收到 Command 缩放滚轮 When 消息合法 Then 换算屏幕坐标并保留原始修饰键', () => {
    /** iframe 私有端口传出的可信滚轮数据副本。 */
    const message = {
      type: CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE,
      deltaX: 1,
      deltaY: -12,
      deltaZ: 0,
      deltaMode: 0,
      clientX: 200,
      clientY: 150,
      ctrlKey: false,
      metaKey: true,
    }

    expect(createCanvasWebviewViewportPortWheelEventInit(message, createFrameMetrics())).toEqual({
      bubbles: true,
      cancelable: true,
      composed: true,
      ctrlKey: false,
      metaKey: true,
      deltaX: 1,
      deltaY: -12,
      deltaZ: 0,
      deltaMode: 0,
      clientX: 200,
      clientY: 125,
    })
  })

  test('Given 私有端口收到越界或无缩放修饰消息 When 解析桥数据 Then 拒绝转发', () => {
    /** 合法消息基线，用于逐项构造非法边界。 */
    const baseData = {
      type: CANVAS_WEBVIEW_VIEWPORT_MESSAGE_TYPE,
      deltaX: 0,
      deltaY: 10,
      deltaZ: 0,
      deltaMode: 0,
      clientX: 20,
      clientY: 30,
      ctrlKey: true,
      metaKey: false,
    }

    expect(createCanvasWebviewViewportPortWheelEventInit(
      { ...baseData, deltaY: Number.POSITIVE_INFINITY },
      createFrameMetrics(),
    )).toBeNull()
    expect(createCanvasWebviewViewportPortWheelEventInit(
      { ...baseData, deltaMode: 9 },
      createFrameMetrics(),
    )).toBeNull()
    expect(createCanvasWebviewViewportPortWheelEventInit(
      { ...baseData, clientX: 801 },
      createFrameMetrics(),
    )).toBeNull()
    expect(createCanvasWebviewViewportPortWheelEventInit(
      { ...baseData, ctrlKey: false },
      createFrameMetrics(),
    )).toBeNull()
  })
})
