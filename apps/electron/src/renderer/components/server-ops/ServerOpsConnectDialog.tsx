import * as React from 'react'
import type { ServerOpsCredentialInput, ServerOpsHost } from '@proma/shared'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/** SSH 登录弹窗属性。 */
export interface ServerOpsConnectDialogProps {
  open: boolean
  host: ServerOpsHost | null
  connecting: boolean
  error?: string
  onOpenChange: (open: boolean) => void
  onSubmit: (credential?: ServerOpsCredentialInput) => Promise<void>
}

/** 根据主机认证方式收集一次性秘密，不把表单值写入 Jotai 或 localStorage。 */
export function ServerOpsConnectDialog({
  open,
  host,
  connecting,
  error,
  onOpenChange,
  onSubmit,
}: ServerOpsConnectDialogProps): React.ReactElement {
  /** 本次连接使用的密码。 */
  const [password, setPassword] = React.useState('')
  /** 本次连接使用的私钥路径。 */
  const [keyPath, setKeyPath] = React.useState('~/.ssh/id_ed25519')
  /** 加密私钥的可选 passphrase。 */
  const [passphrase, setPassphrase] = React.useState('')
  /** 用户是否明确允许把凭据写入 safeStorage 密文。 */
  const [remember, setRemember] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setPassword('')
    setKeyPath(host?.credentialRef ? '' : '~/.ssh/id_ed25519')
    setPassphrase('')
    setRemember(false)
  }, [host?.id, open])

  /** 构造与主机认证方式一致的单次连接凭据。 */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    if (!host) return
    if (host.authMethod === 'ssh-agent') {
      void onSubmit({ kind: 'ssh-agent' })
      return
    }
    if (host.authMethod === 'password') {
      /** 已有安全凭据时允许留空直接使用；否则提交本次密码。 */
      void onSubmit(password ? { kind: 'password', password, remember } : undefined)
      return
    }
    /** 已有安全凭据时私钥路径可留空以复用，否则提交新路径。 */
    void onSubmit(keyPath ? {
      kind: 'private-key',
      keyPath,
      ...(passphrase ? { passphrase } : {}),
      remember,
    } : undefined)
  }

  /** 当前表单是否满足最小提交条件。 */
  const canSubmit = host?.authMethod === 'ssh-agent'
    || Boolean(host?.credentialRef)
    || (host?.authMethod === 'password' ? password.length > 0 : keyPath.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!connecting) onOpenChange(nextOpen) }}>
      <DialogContent className="max-w-md">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>登录 {host?.name ?? '服务器'}</DialogTitle>
            <DialogDescription>{host ? `${host.username}@${host.address}:${host.port}` : 'SSH 登录'}</DialogDescription>
          </DialogHeader>
          {host?.authMethod === 'password' && (
            <div className="grid gap-1.5">
              <Label htmlFor="server-ops-password">密码</Label>
              <Input
                id="server-ops-password"
                type="password"
                value={password}
                autoFocus
                autoComplete="current-password"
                placeholder={host.credentialRef ? '留空使用已保存密码' : '输入 SSH 密码'}
                onChange={(event) => setPassword(event.target.value)}
              />
            </div>
          )}
          {host?.authMethod === 'private-key' && (
            <>
              <div className="grid gap-1.5">
                <Label htmlFor="server-ops-private-key">私钥路径</Label>
                <Input
                  id="server-ops-private-key"
                  value={keyPath}
                  autoFocus
                  placeholder={host.credentialRef ? '留空使用已保存私钥' : '~/.ssh/id_ed25519'}
                  onChange={(event) => setKeyPath(event.target.value)}
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="server-ops-passphrase">私钥口令</Label>
                <Input id="server-ops-passphrase" type="password" value={passphrase} autoComplete="off" placeholder="没有口令可留空" onChange={(event) => setPassphrase(event.target.value)} />
              </div>
            </>
          )}
          {host?.authMethod === 'ssh-agent' && (
            <div className="border-y border-border py-3 text-xs leading-5 text-muted-foreground">
              将使用系统 SSH Agent 中已加载的密钥。Proma 不读取或保存私钥。
            </div>
          )}
          {host?.authMethod !== 'ssh-agent' && (
            <label className="flex cursor-pointer items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={remember}
                className="mt-0.5 size-3.5 accent-primary"
                onChange={(event) => setRemember(event.target.checked)}
              />
              <span>
                记住登录凭据
                <span className="mt-0.5 block text-[11px] text-muted-foreground">使用系统安全存储加密；默认仅用于本次运行。</span>
              </span>
            </label>
          )}
          {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={connecting} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={connecting || !canSubmit}>{connecting ? '正在连接...' : '连接'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
