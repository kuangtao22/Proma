import { describe, expect, test } from 'bun:test'
import { ComfyProgressStream } from './comfyui-progress-stream'

class FakeSocket {
  listeners = new Map<string, Array<(...args: unknown[]) => void>>()
  closed = false
  on(event: string, listener: (...args: unknown[]) => void): this { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this }
  close(): void { this.closed = true }
  send(event: string, data: unknown, binary?: boolean): void { for (const listener of this.listeners.get(event) ?? []) listener(data, binary) }
}

describe('ComfyProgressStream', () => {
  test('同连接实例复用单 socket，且只投递精确 prompt', () => {
    const sockets: FakeSocket[] = []
    const stream = new ComfyProgressStream({ socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket } })
    const first: unknown[] = []; const second: unknown[] = []
    const off1 = stream.subscribe({ connectionId: 'c', instanceGeneration: '1', baseUrl: 'http://x', clientId: 'p' }, (event) => first.push(event))
    const off2 = stream.subscribe({ connectionId: 'c', instanceGeneration: '1', baseUrl: 'http://x', clientId: 'p' }, (event) => second.push(event))
    expect(sockets).toHaveLength(1)
    sockets[0]!.send('message', JSON.stringify({ type: 'progress', data: { prompt_id: 'p1', node: '3', value: 2, max: 5 } }))
    sockets[0]!.send('message', JSON.stringify({ type: 'progress', data: { node: '3', value: 2, max: 5 } }))
    expect(first).toEqual([{ type: 'progress', promptId: 'p1', nodeId: '3', value: 2, max: 5 }]); expect(second).toHaveLength(1)
    off1(); off2(); expect(sockets[0]!.closed).toBe(true)
  })
  test('拒绝二进制、超长帧和非法数值，node null 只 changed', () => {
    const socket = new FakeSocket(); const events: unknown[] = []
    new ComfyProgressStream({ socketFactory: () => socket }).subscribe({ connectionId: 'c', instanceGeneration: '1', baseUrl: 'http://x', clientId: 'p' }, (event) => events.push(event))
    socket.send('message', Buffer.from('preview')); socket.send('message', JSON.stringify({ type: 'progress', data: { prompt_id: 'p', value: -1, max: 2 } }))
    socket.send('message', JSON.stringify({ type: 'executing', data: { prompt_id: 'p', node: null } }))
    expect(events).toEqual([{ type: 'changed', promptId: 'p' }])
  })
  test('断线指数重连，旧 socket 迟到事件被丢弃', () => {
    const sockets: FakeSocket[] = []; const timers: Array<() => void> = []
    const stream = new ComfyProgressStream({ socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket }, setTimeout: (handler) => { timers.push(handler); return timers.length as unknown as ReturnType<typeof setTimeout> }, clearTimeout: () => {} })
    const events: unknown[] = []; stream.subscribe({ connectionId: 'c', instanceGeneration: '1', baseUrl: 'http://x', clientId: 'p' }, (event) => events.push(event))
    sockets[0]!.send('close', undefined); expect(timers).toHaveLength(1); timers[0]!(); expect(sockets).toHaveLength(2)
    sockets[0]!.send('message', JSON.stringify({ type: 'execution_success', data: { prompt_id: 'old' } })); expect(events).toHaveLength(1)
  })
  test('Given ws 以 Buffer 投递文本帧 When isBinary=false Then 处理进度且真实二进制帧不进入 JSON 通道', () => {
    const socket = new FakeSocket()
    const events: unknown[] = []
    const stream = new ComfyProgressStream({ socketFactory: () => socket })
    stream.subscribe({ connectionId: 'c', instanceGeneration: '1', baseUrl: 'http://x/proxy/comfy', clientId: 'p' }, (event) => events.push(event))
    const frame = Buffer.from(JSON.stringify({ type: 'progress', data: { prompt_id: 'p', node: '4', value: 12, max: 30 } }))
    socket.send('message', frame, false)
    socket.send('message', frame, true)
    expect(events).toEqual([{ type: 'progress', promptId: 'p', nodeId: '4', value: 12, max: 30 }])
    stream.dispose()
  })
})
