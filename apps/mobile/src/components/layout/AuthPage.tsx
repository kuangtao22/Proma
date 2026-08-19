import { useState, useCallback } from 'react'
import type { FormEvent } from 'react'
import { useAtom } from 'jotai'
import { LoaderCircle, Monitor, ShieldCheck } from 'lucide-react'
import { pinAtom, bridgeHostAtom, bridgePortAtom } from '../../atoms'
import { wsReq, WsClientError } from '../../lib/ws-client'
import type { TrustedDeviceAuthentication } from '../../lib/pairing-startup-coordinator'

interface Props {
  /** 当前浏览器安装持久化使用的稳定设备标识。 */
  deviceId: string
  /** PIN 配对成功后保存完整可信设备认证材料。 */
  onSuccess: (authentication: TrustedDeviceAuthentication) => void
  /** 扫码票据是否正在等待能力协商或认证响应。 */
  pairingPending?: boolean
  /** 不含票据内容的扫码配对失败提示。 */
  pairingError?: string
  /** 用户转为手工 PIN 连接时清理扫码提示。 */
  onManualAttempt?: () => void
}

export function AuthPage({
  deviceId,
  onSuccess,
  pairingPending = false,
  pairingError = '',
  onManualAttempt,
}: Props) {
  const [pin, setPin] = useAtom(pinAtom)
  const [host, setHost] = useAtom(bridgeHostAtom)
  const [port, setPort] = useAtom(bridgePortAtom)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  const handleSubmit = useCallback(async (e: FormEvent) => {
    e.preventDefault()
    onManualAttempt?.()
    if (!pin || pin.length !== 6) { setError('请输入 6 位 PIN 码'); return }
    setError(''); setLoading(true)
    try {
      /** PIN 配对同样注册为可撤销的长期可信设备。 */
      const r = await wsReq('auth.pair', {
        pin,
        deviceName: 'Proma 手机端',
        deviceId,
      }) as TrustedDeviceAuthentication
      localStorage.setItem('proma_mobile_host', host)
      localStorage.setItem('proma_mobile_port', port)
      onSuccess(r)
    } catch (err: unknown) {
      setError(err instanceof WsClientError && err.code === 'TIMEOUT' ? '连接超时，请检查地址和 PIN 码' : 'PIN 码错误或服务不可用')
    } finally {
      setLoading(false)
    }
  }, [pin, host, port, deviceId, onSuccess, onManualAttempt])

  return (
    <main
      className="min-h-full overflow-y-auto bg-content px-5 text-foreground"
      style={{ paddingTop: 'max(var(--safe-t), 24px)', paddingBottom: 'max(var(--safe-b), 24px)' }}
    >
      <div className="mx-auto flex min-h-full w-full max-w-sm flex-col justify-center py-8">
        <header className="mb-8">
          <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-md border border-border bg-card text-card-foreground shadow-sm">
            <Monitor aria-hidden="true" className="h-5 w-5" strokeWidth={1.8} />
          </div>
          <h1 className="text-[28px] font-semibold leading-tight">Proma</h1>
          <p className="mt-1 text-sm text-muted-foreground">连接桌面端，继续当前工作</p>
        </header>
        {pairingPending && (
          <div className="mb-3 flex min-h-10 items-center gap-2 rounded-md border border-border bg-muted/50 px-3 py-2.5 text-sm text-foreground" role="status">
            <LoaderCircle aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
            正在验证扫码连接...
          </div>
        )}
        {pairingError && (
          <div className="mb-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2.5 text-sm text-destructive" role="alert">
            {pairingError}
          </div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4" aria-label="手工连接">
          <div>
            <label htmlFor="auth-host" className="mb-1.5 block text-xs font-medium text-muted-foreground">地址</label>
            <input
              id="auth-host"
              type="text" value={host} onChange={e => setHost(e.target.value)}
              className="h-11 w-full rounded-md border border-input bg-input-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:ring-2 focus:ring-ring/15"
              placeholder="192.168.x.x"
            />
          </div>
          <div>
            <label htmlFor="auth-port" className="mb-1.5 block text-xs font-medium text-muted-foreground">端口</label>
            <input
              id="auth-port"
              type="text" value={port} onChange={e => setPort(e.target.value)}
              className="h-11 w-full rounded-md border border-input bg-input-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-foreground/30 focus:ring-2 focus:ring-ring/15"
              placeholder="29888"
            />
          </div>
          <div>
            <label htmlFor="auth-pin" className="mb-1.5 block text-xs font-medium text-muted-foreground">PIN 码</label>
            <input
              id="auth-pin"
              type="text" inputMode="numeric" maxLength={6} autoFocus
              value={pin} onChange={e => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
              className="h-12 w-full rounded-md border border-input bg-input-surface px-3 text-center font-mono text-lg tracking-[0.3em] text-foreground outline-none transition-colors placeholder:text-muted-foreground/40 focus:border-foreground/30 focus:ring-2 focus:ring-ring/15"
              placeholder="000000"
            />
          </div>
          {error && <p className="text-xs text-destructive" role="alert">{error}</p>}
          <button
            aria-label="连接到桌面 Proma"
            type="submit" disabled={loading || pairingPending}
            className="h-11 w-full rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {loading ? '连接中...' : '连接'}
          </button>
        </form>
        <div className="mt-6 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <p>在电脑端 Proma → 设置 → 远程连接 → 局域网 查看 PIN 码</p>
        </div>
      </div>
    </main>
  )
}
