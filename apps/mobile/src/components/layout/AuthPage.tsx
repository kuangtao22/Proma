import { useState, useCallback } from 'react'
import type { FormEvent } from 'react'
import { useAtom } from 'jotai'
import { pinAtom, bridgeHostAtom, bridgePortAtom } from '../../atoms'
import { wsReq, WsClientError } from '../../lib/ws-client'

interface Props {
  onSuccess: (token: string) => void
}

export function AuthPage({ onSuccess }: Props) {
  const [pin, setPin] = useAtom(pinAtom)
  const [host, setHost] = useAtom(bridgeHostAtom)
  const [port, setPort] = useAtom(bridgePortAtom)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    if (!pin || pin.length !== 6) { setError('请输入 6 位 PIN 码'); return }
    setError(''); setLoading(true)
    try {
      const r = await wsReq('auth.pair', { pin }) as { token: string }
      localStorage.setItem('proma_mobile_host', host)
      localStorage.setItem('proma_mobile_port', port)
      onSuccess(r.token)
    } catch (err: unknown) {
      setError(err instanceof WsClientError && err.code === 'TIMEOUT' ? '连接超时，请检查地址和 PIN 码' : 'PIN 码错误或服务不可用')
    } finally {
      setLoading(false)
    }
  }, [pin, host, port, onSuccess])

  return (
    <div className="flex flex-col items-center justify-center min-h-full px-6 bg-background" style={{ paddingTop: 'var(--safe-t)', paddingBottom: 'var(--safe-b)' }}>
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-bold text-foreground text-center mb-2">Proma</h1>
        <p className="text-muted-foreground text-sm text-center mb-8">连接到电脑端 Proma</p>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm text-muted-foreground mb-1">地址</label>
            <input
              type="text" value={host} onChange={e => setHost(e.target.value)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="192.168.x.x"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">端口</label>
            <input
              type="text" value={port} onChange={e => setPort(e.target.value)}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="29888"
            />
          </div>
          <div>
            <label className="block text-sm text-muted-foreground mb-1">PIN 码</label>
            <input
              type="text" inputMode="numeric" maxLength={6} autoFocus
              value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="w-full rounded-lg border border-border bg-muted px-3 py-2.5 text-foreground text-lg tracking-[0.3em] text-center font-mono focus:outline-none focus:ring-2 focus:ring-ring"
              placeholder="000000"
            />
          </div>
          {error && <p className="text-red-400 text-xs text-center">{error}</p>}
          <button
            type="submit" disabled={loading}
            className="w-full rounded-lg bg-primary text-primary-foreground py-3 font-medium text-sm hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {loading ? '连接中...' : '连接'}
          </button>
        </form>
        <p className="text-muted-foreground/40 text-xs text-center mt-6">
          在电脑端 Proma → 设置 → 远程连接 → 局域网 查看 PIN 码
        </p>
      </div>
    </div>
  )
}
