import * as React from 'react'
import { Eye, EyeOff, KeyRound, ShieldCheck, Trash2 } from 'lucide-react'
import type {
  ServerOpsAuthMethod,
  ServerOpsCredentialUpdate,
  ServerOpsHost,
  ServerOpsSaveHostInput,
  ServerOpsUpsertHostInput,
} from '@proma/shared'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

/** 主机表单弹窗属性。 */
export interface ServerOpsHostDialogProps {
  open: boolean
  host: ServerOpsHost | null
  saving: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (input: ServerOpsSaveHostInput) => Promise<void>
}

/** 服务器配置内受控凭据字段属性。 */
export interface ServerOpsCredentialFieldsProps {
  authMethod: ServerOpsAuthMethod
  credentialAction: ServerOpsCredentialUpdate['action']
  hasSavedCredential: boolean
  password: string
  keyPath: string
  passphrase: string
  showPassword: boolean
  onCredentialActionChange: (action: ServerOpsCredentialUpdate['action']) => void
  onPasswordChange: (password: string) => void
  onKeyPathChange: (keyPath: string) => void
  onPassphraseChange: (passphrase: string) => void
  onShowPasswordChange: (showPassword: boolean) => void
}

/** 根据主机原认证状态解析打开表单时的凭据动作。 */
function resolveInitialCredentialAction(
  host: ServerOpsHost | null,
  authMethod: ServerOpsAuthMethod,
): ServerOpsCredentialUpdate['action'] {
  if (authMethod === 'ssh-agent') return 'clear'
  return host?.authMethod === authMethod && host.credentialRef ? 'keep' : 'replace'
}

/** 展示凭据保存状态，或收集需要替换并安全保存的新凭据。 */
export function ServerOpsCredentialFields({
  authMethod,
  credentialAction,
  hasSavedCredential,
  password,
  keyPath,
  passphrase,
  showPassword,
  onCredentialActionChange,
  onPasswordChange,
  onKeyPathChange,
  onPassphraseChange,
  onShowPasswordChange,
}: ServerOpsCredentialFieldsProps): React.ReactElement {
  if (authMethod === 'ssh-agent') {
    return (
      <div className="flex items-start gap-2 border-y border-border py-3 text-xs leading-5 text-muted-foreground">
        <KeyRound className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span>将使用系统 SSH Agent 中已加载的密钥，Proma 不读取或保存私钥。</span>
      </div>
    )
  }

  if (credentialAction === 'keep' && hasSavedCredential) {
    return (
      <div className="flex flex-wrap items-center gap-2 border-y border-border py-3">
        <ShieldCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <div className="min-w-40 flex-1">
          <div className="text-xs font-medium">凭据已保存</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">已由系统安全存储加密，编辑时不会回填明文。</div>
        </div>
        <div className="flex items-center gap-1">
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onCredentialActionChange('replace')}>
            替换凭据
          </Button>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px] text-destructive hover:text-destructive" onClick={() => onCredentialActionChange('clear')}>
            <Trash2 className="size-3.5" aria-hidden="true" />清除凭据
          </Button>
        </div>
      </div>
    )
  }

  if (credentialAction === 'clear') {
    return (
      <div className="flex flex-wrap items-center gap-2 border-y border-border py-3">
        <Trash2 className="size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div className="min-w-40 flex-1">
          <div className="text-xs font-medium">保存后将清除凭据</div>
          <div className="mt-0.5 text-[11px] text-muted-foreground">下次连接时需要重新输入登录信息。</div>
        </div>
        <Button type="button" variant="outline" size="sm" className="h-7 px-2 text-[11px]" onClick={() => onCredentialActionChange(hasSavedCredential ? 'keep' : 'replace')}>
          {hasSavedCredential ? '撤销清除' : '配置凭据'}
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-3">
      {hasSavedCredential && (
        <div className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
          <span>新凭据将在保存后替换现有凭据。</span>
          <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-[11px]" onClick={() => onCredentialActionChange('keep')}>
            保留原凭据
          </Button>
        </div>
      )}
      {authMethod === 'password' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-host-password">SSH 密码</Label>
          <div className="relative">
            <Input
              id="server-ops-host-password"
              type={showPassword ? 'text' : 'password'}
              value={password}
              required
              autoComplete="new-password"
              className="pr-9"
              placeholder="输入 SSH 密码"
              onChange={(event) => onPasswordChange(event.target.value)}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-1 top-1/2 -translate-y-1/2"
              aria-label={showPassword ? '隐藏密码' : '显示密码'}
              title={showPassword ? '隐藏密码' : '显示密码'}
              onClick={() => onShowPasswordChange(!showPassword)}
            >
              {showPassword ? <EyeOff className="size-3.5" aria-hidden="true" /> : <Eye className="size-3.5" aria-hidden="true" />}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid gap-1.5">
            <Label htmlFor="server-ops-host-private-key">私钥文件</Label>
            <Input
              id="server-ops-host-private-key"
              value={keyPath}
              required
              autoComplete="off"
              placeholder="~/.ssh/id_ed25519"
              onChange={(event) => onKeyPathChange(event.target.value)}
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="server-ops-host-passphrase">私钥口令</Label>
            <Input
              id="server-ops-host-passphrase"
              type="password"
              value={passphrase}
              autoComplete="new-password"
              placeholder="没有口令可留空"
              onChange={(event) => onPassphraseChange(event.target.value)}
            />
          </div>
        </>
      )}
      <p className="text-[11px] leading-4 text-muted-foreground">保存时使用系统安全存储加密，不写入服务器资产文件。</p>
    </div>
  )
}

/** 创建或编辑 Linux SSH 主机及其安全凭据。 */
export function ServerOpsHostDialog({
  open,
  host,
  saving,
  onOpenChange,
  onSubmit,
}: ServerOpsHostDialogProps): React.ReactElement {
  /** 用户可识别的服务器名称。 */
  const [name, setName] = React.useState('')
  /** IP 地址或 DNS 主机名。 */
  const [address, setAddress] = React.useState('')
  /** SSH 端口文本，提交时转为整数。 */
  const [port, setPort] = React.useState('22')
  /** SSH 登录用户名。 */
  const [username, setUsername] = React.useState('')
  /** 当前选择的 SSH 认证方式。 */
  const [authMethod, setAuthMethod] = React.useState<ServerOpsAuthMethod>('ssh-agent')
  /** 逗号分隔的服务器标签输入。 */
  const [tags, setTags] = React.useState('')
  /** 保存时对已有安全凭据执行的动作。 */
  const [credentialAction, setCredentialAction] = React.useState<ServerOpsCredentialUpdate['action']>('clear')
  /** 待加密保存的新 SSH 密码。 */
  const [password, setPassword] = React.useState('')
  /** 待加密保存的私钥路径。 */
  const [keyPath, setKeyPath] = React.useState('~/.ssh/id_ed25519')
  /** 待加密保存的可选私钥口令。 */
  const [passphrase, setPassphrase] = React.useState('')
  /** 用户是否临时查看当前输入的密码。 */
  const [showPassword, setShowPassword] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    /** 打开弹窗时使用主机现有认证方式或新建默认值。 */
    const nextAuthMethod = host?.authMethod ?? 'ssh-agent'
    setName(host?.name ?? '')
    setAddress(host?.address ?? '')
    setPort(String(host?.port ?? 22))
    setUsername(host?.username ?? '')
    setAuthMethod(nextAuthMethod)
    setTags(host?.tags.join(', ') ?? '')
    setCredentialAction(resolveInitialCredentialAction(host, nextAuthMethod))
    setPassword('')
    setKeyPath('~/.ssh/id_ed25519')
    setPassphrase('')
    setShowPassword(false)
  }, [host, open])

  /** 切换认证方式并按现有安全凭据状态重置编辑动作。 */
  const handleAuthMethodChange = (nextAuthMethod: ServerOpsAuthMethod): void => {
    setAuthMethod(nextAuthMethod)
    setCredentialAction(resolveInitialCredentialAction(host, nextAuthMethod))
    setPassword('')
    setKeyPath('~/.ssh/id_ed25519')
    setPassphrase('')
    setShowPassword(false)
  }

  /** 将表单字段构造为公开主机与秘密变更分离的共享合同。 */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    /** 去空白、去重后的标签列表。 */
    const normalizedTags = [...new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))]
    /** 提交给 Preload 的无凭据主机字段。 */
    const hostInput: ServerOpsUpsertHostInput = {
      ...(host ? { id: host.id } : {}),
      name,
      address,
      port: Number(port),
      username,
      authMethod,
      tags: normalizedTags,
    }
    /** 认证组当前选择对应的安全凭据变更。 */
    const credentialUpdate: ServerOpsCredentialUpdate = credentialAction === 'keep'
      ? { action: 'keep' }
      : credentialAction === 'clear' || authMethod === 'ssh-agent'
        ? { action: 'clear' }
        : authMethod === 'password'
          ? { action: 'replace', credential: { kind: 'password', password } }
          : {
              action: 'replace',
              credential: {
                kind: 'private-key',
                keyPath,
                ...(passphrase ? { passphrase } : {}),
              },
            }
    void onSubmit({ host: hostInput, credentialUpdate })
  }

  /** 当前凭据字段是否满足组合保存的最小要求。 */
  const credentialReady = authMethod === 'ssh-agent'
    || credentialAction === 'keep'
    || credentialAction === 'clear'
    || (authMethod === 'password' ? password.length > 0 : keyPath.trim().length > 0)

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen) }}>
      <DialogContent className="max-h-[min(90vh,44rem)] max-w-lg overflow-y-auto">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{host ? '编辑服务器' : '添加服务器'}</DialogTitle>
            <DialogDescription>连接信息与凭据一起保存；秘密由系统安全存储加密。</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="server-ops-name">名称</Label>
              <Input id="server-ops-name" value={name} maxLength={100} required autoFocus onChange={(event) => setName(event.target.value)} />
            </div>
            <div className="grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
              <div className="grid gap-1.5">
                <Label htmlFor="server-ops-address">主机地址</Label>
                <Input id="server-ops-address" value={address} maxLength={255} required placeholder="10.0.0.8" onChange={(event) => setAddress(event.target.value)} />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="server-ops-port">端口</Label>
                <Input id="server-ops-port" value={port} type="number" min={1} max={65_535} required onChange={(event) => setPort(event.target.value)} />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="server-ops-username">用户名</Label>
              <Input id="server-ops-username" value={username} maxLength={64} required placeholder="deploy" onChange={(event) => setUsername(event.target.value)} />
            </div>
            <div className="grid gap-1.5">
              <Label>认证方式</Label>
              <Select value={authMethod} onValueChange={handleAuthMethodChange}>
                <SelectTrigger aria-label="认证方式">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="password">密码</SelectItem>
                  <SelectItem value="ssh-agent">SSH Agent</SelectItem>
                  <SelectItem value="private-key">私钥文件</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <ServerOpsCredentialFields
              authMethod={authMethod}
              credentialAction={credentialAction}
              hasSavedCredential={Boolean(host?.credentialRef && host.authMethod === authMethod)}
              password={password}
              keyPath={keyPath}
              passphrase={passphrase}
              showPassword={showPassword}
              onCredentialActionChange={setCredentialAction}
              onPasswordChange={setPassword}
              onKeyPathChange={setKeyPath}
              onPassphraseChange={setPassphrase}
              onShowPasswordChange={setShowPassword}
            />
            <div className="grid gap-1.5">
              <Label htmlFor="server-ops-tags">标签</Label>
              <Input id="server-ops-tags" value={tags} placeholder="生产, API" onChange={(event) => setTags(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving || !credentialReady}>{saving ? '正在保存...' : '保存服务器'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
