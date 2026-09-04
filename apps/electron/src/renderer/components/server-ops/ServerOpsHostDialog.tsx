import * as React from 'react'
import type { ServerOpsAuthMethod, ServerOpsHost, ServerOpsUpsertHostInput } from '@proma/shared'
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
  onSubmit: (input: ServerOpsUpsertHostInput) => Promise<void>
}

/** 创建或编辑不含凭据的 Linux SSH 主机。 */
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
  /** 只保存认证方式，不在主机资产中保存秘密。 */
  const [authMethod, setAuthMethod] = React.useState<ServerOpsAuthMethod>('ssh-agent')
  /** 逗号分隔的服务器标签输入。 */
  const [tags, setTags] = React.useState('')

  React.useEffect(() => {
    if (!open) return
    setName(host?.name ?? '')
    setAddress(host?.address ?? '')
    setPort(String(host?.port ?? 22))
    setUsername(host?.username ?? '')
    setAuthMethod(host?.authMethod ?? 'ssh-agent')
    setTags(host?.tags.join(', ') ?? '')
  }, [host, open])

  /** 将表单字段重新构造为安全的共享合同输入。 */
  const handleSubmit = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    /** 去空白、去重后的标签列表。 */
    const normalizedTags = [...new Set(tags.split(',').map((tag) => tag.trim()).filter(Boolean))]
    /** 提交给 Preload 的无凭据主机字段。 */
    const input: ServerOpsUpsertHostInput = {
      ...(host ? { id: host.id } : {}),
      name,
      address,
      port: Number(port),
      username,
      authMethod,
      tags: normalizedTags,
    }
    void onSubmit(input)
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) onOpenChange(nextOpen) }}>
      <DialogContent className="max-w-md">
        <form className="grid gap-4" onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{host ? '编辑服务器' : '添加服务器'}</DialogTitle>
            <DialogDescription>保存连接身份；密码不会写入主机资产文件。</DialogDescription>
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
              <Select value={authMethod} onValueChange={(value: ServerOpsAuthMethod) => setAuthMethod(value)}>
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
            <div className="grid gap-1.5">
              <Label htmlFor="server-ops-tags">标签</Label>
              <Input id="server-ops-tags" value={tags} placeholder="生产, API" onChange={(event) => setTags(event.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={saving}>{saving ? '正在保存...' : '保存服务器'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
