declare module 'ws' {
  import { EventEmitter } from 'node:events'
  import type { IncomingMessage } from 'node:http'

  export class WebSocket extends EventEmitter {
    static readonly OPEN: number
    static readonly CLOSED: number
    readonly readyState: number
    constructor(url: string, options?: { headers?: Record<string, string> })
    send(data: string | Buffer | ArrayBuffer | Uint8Array, cb?: (err?: Error) => void): void
    close(code?: number, reason?: string): void
    terminate(): void
  }

  export class WebSocketServer extends EventEmitter {
    constructor(options?: {
      noServer?: boolean
      server?: unknown
      port?: number
      host?: string
    })
    handleUpgrade(
      req: IncomingMessage,
      socket: unknown,
      head: Buffer,
      callback: (ws: WebSocket) => void,
    ): void
    close(callback?: (err?: Error) => void): void
    on(event: 'connection', listener: (ws: WebSocket, req: IncomingMessage) => void): this
    on(event: 'error', listener: (err: Error) => void): this
    on(event: 'close', listener: () => void): this
    on(event: 'listening', listener: () => void): this
    on(event: string | symbol, listener: (...args: any[]) => void): this
    emit(event: string | symbol, ...args: any[]): boolean
  }

  export default WebSocket
}
