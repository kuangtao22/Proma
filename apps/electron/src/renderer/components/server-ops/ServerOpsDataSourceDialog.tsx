import * as React from 'react'
import { Eye, EyeOff, FileUp, LoaderCircle, PlugZap } from 'lucide-react'
import type {
  ServerOpsConnectionDraftInput,
  ServerOpsDataEngine,
  ServerOpsDataProbeResult,
  ServerOpsDataSource,
  ServerOpsDataSourceProbeDraft,
  ServerOpsDataSourceUpsertInput,
  ServerOpsDataTlsMode,
  ServerOpsDataTransport,
} from '@proma/shared'
import { isServerOpsLocalSqliteFilePath, isServerOpsMySqlTlsServerName, isServerOpsPlaintextDirectAddress, isServerOpsSqliteFilePath } from '@proma/shared'
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
import { cn } from '@/lib/utils'
import {
  formatServerOpsDataProbeSummary,
  getServerOpsDataErrorMessage,
} from './server-ops-data-display'

/** 引擎到默认端口的映射，切换引擎时带入避免用户手填常见值。 */
const DEFAULT_ENGINE_PORTS: Partial<Record<ServerOpsDataEngine, number>> = { mysql: 3306, redis: 6379 }

/** Renderer 在提交阶段同步失效旧会话；SSR 静态测试使用普通 Effect 避免无意义警告。 */
const useServerOpsDialogLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/** 数据源表单草稿；端口保持字符串以支持中间态编辑。 */
export interface ServerOpsDataSourceDraft {
  /** 连接方式：本机直连或经由跳板主机。 */
  transport: ServerOpsDataTransport
  /** SQLite 所在的 SSH 服务器；网络数据库继续由弹窗外的兼容字段提供默认值。 */
  hostId: string
  engine: ServerOpsDataEngine
  label: string
  address: string
  port: string
  /** SQLite 在远端服务器上的绝对文件路径。 */
  filePath: string
  /** 仅用于 Redis 逻辑库和 SQLite 固定 main；MySQL 连接后再选库。 */
  database: string
  username: string
  password: string
  clearPassword: boolean
  tlsMode: ServerOpsDataTlsMode
  tlsServerName: string
}

/** 表单层连接方式；本地 SQLite 仍映射到既有 direct + sqlite 后端合同。 */
export type ServerOpsDataConnectionMode = ServerOpsDataTransport | 'local-sqlite'

/** 表单字段错误集合。 */
export interface ServerOpsDataSourceFormErrors {
  label?: string
  address?: string
  port?: string
  hostId?: string
  filePath?: string
  database?: string
  tlsMode?: string
  tlsServerName?: string
}

/**
 * 按数据源与模式创建初始草稿；编辑时不回填已保存密码。
 *
 * @param source 编辑目标；新建时为 null
 * @param initialEngine 新建时的初始引擎；编辑时以现有记录为准
 * @returns 初始草稿
 */
export function createServerOpsDataSourceDraft(
  source: ServerOpsDataSource | null,
  initialEngine: ServerOpsDataEngine = 'mysql',
  initialDraft?: Extract<ServerOpsConnectionDraftInput, { kind: 'mysql' | 'redis' | 'sqlite' }> | null,
): ServerOpsDataSourceDraft {
  /** 初始引擎。 */
  const engine = source?.engine ?? initialEngine
  const base: ServerOpsDataSourceDraft = {
    transport: source?.transport ?? (engine === 'sqlite' ? 'ssh' : 'direct'),
    hostId: source?.hostId ?? '',
    engine,
    label: source?.label ?? '',
    address: source?.address ?? (engine === 'sqlite' ? '' : '127.0.0.1'),
    port: source?.port === undefined ? String(DEFAULT_ENGINE_PORTS[engine] ?? '') : String(source.port),
    filePath: source?.filePath ?? '',
    database: engine === 'sqlite' ? 'main' : engine === 'redis' ? source?.database ?? '' : '',
    username: source?.username ?? '',
    password: '',
    clearPassword: false,
    tlsMode: source?.tlsMode ?? (engine === 'mysql' ? 'preferred' : 'disabled'),
    tlsServerName: source?.tlsServerName ?? (source?.tlsMode === 'verify' ? source.address ?? '' : ''),
  }
  if (source || !initialDraft) return base
  return {
    ...base,
    engine: initialDraft.kind,
    label: initialDraft.label,
    transport: initialDraft.transport,
    hostId: initialDraft.hostId ?? '',
    ...(initialDraft.kind === 'sqlite' ? { filePath: initialDraft.filePath } : {
      address: initialDraft.address,
      port: String(initialDraft.port),
      username: initialDraft.username ?? '',
      database: initialDraft.kind === 'redis' ? initialDraft.database ?? '' : '',
      tlsMode: initialDraft.tlsMode ?? (initialDraft.kind === 'mysql' ? 'preferred' : 'disabled'),
      tlsServerName: initialDraft.tlsServerName ?? '',
    }),
  }
}

/** 切换引擎：带入默认端口，并清空不适用于目标引擎的数据库选择。 */
export function applyServerOpsDataSourceEngineChange(
  draft: ServerOpsDataSourceDraft,
  engine: ServerOpsDataEngine,
): ServerOpsDataSourceDraft {
  /** 本地文件模式的 SQLite 由连接方式控制，网络直连不能通过引擎选择隐式进入本地模式。 */
  if (engine === 'sqlite' && draft.transport !== 'ssh') return draft
  return {
    ...draft,
    engine,
    ...(engine === 'sqlite' ? {
      address: '',
      port: '',
      database: 'main',
      username: '',
      password: '',
      clearPassword: false,
      tlsMode: 'disabled' as const,
      tlsServerName: '',
    } : {
      address: draft.engine === 'sqlite' ? '127.0.0.1' : draft.address,
      port: String(DEFAULT_ENGINE_PORTS[engine]),
      filePath: '',
      database: '',
      ...(engine === 'redis' && draft.tlsMode === 'preferred' ? { tlsMode: 'required' as const } : {}),
      ...(engine === 'mysql' && draft.engine === 'sqlite' ? { tlsMode: 'preferred' as const } : {}),
    }),
  }
}

/** 从后端草稿推导表单的三态连接方式。 */
export function getServerOpsDataConnectionMode(draft: ServerOpsDataSourceDraft): ServerOpsDataConnectionMode {
  return draft.engine === 'sqlite' && draft.transport === 'direct' ? 'local-sqlite' : draft.transport
}

/** 返回指定连接方式可选择的数据库引擎，供表单渲染与规则测试共用。 */
export function getServerOpsDataConnectionModeEngines(
  mode: ServerOpsDataConnectionMode,
): readonly ServerOpsDataEngine[] {
  if (mode === 'local-sqlite') return ['sqlite']
  if (mode === 'ssh') return ['mysql', 'redis', 'sqlite']
  return ['mysql', 'redis']
}

/** 切换表单连接方式；只转换既有 engine/transport 字段，不扩展后端枚举。 */
export function applyServerOpsDataConnectionModeChange(
  draft: ServerOpsDataSourceDraft,
  mode: ServerOpsDataConnectionMode,
  defaultHostId = '',
): ServerOpsDataSourceDraft {
  if (mode === 'local-sqlite') {
    return {
      ...draft,
      transport: 'direct',
      engine: 'sqlite',
      hostId: '',
      address: '',
      port: '',
      filePath: getServerOpsDataConnectionMode(draft) === 'local-sqlite' ? draft.filePath : '',
      database: 'main',
      username: '',
      password: '',
      clearPassword: false,
      tlsMode: 'disabled',
      tlsServerName: '',
    }
  }
  if (mode === 'ssh') {
    return {
      ...draft,
      transport: 'ssh',
      hostId: draft.hostId || defaultHostId,
      /** 本地路径不能冒充服务器路径；SQLite 引擎本身继续保留。 */
      ...(getServerOpsDataConnectionMode(draft) === 'local-sqlite' ? { filePath: '' } : {}),
    }
  }
  if (draft.engine !== 'sqlite') return { ...draft, transport: 'direct', hostId: '' }
  /** 从任一 SQLite 文件模式切到网络直连时恢复可立即编辑的 MySQL 默认值。 */
  return {
    ...draft,
    transport: 'direct',
    hostId: '',
    engine: 'mysql',
    address: '127.0.0.1',
    port: String(DEFAULT_ENGINE_PORTS.mysql),
    filePath: '',
    database: '',
    username: '',
    password: '',
    clearPassword: false,
    tlsMode: 'preferred',
    tlsServerName: '',
  }
}

/** 应用本机文件选择结果；取消选择时完整保留当前草稿。 */
export function applyServerOpsLocalSqliteFileSelection(
  draft: ServerOpsDataSourceDraft,
  selection: { filePath: string; fileName: string } | null,
): ServerOpsDataSourceDraft {
  if (selection === null) return draft
  return {
    ...draft,
    filePath: selection.filePath,
    ...(draft.label.trim() === '' ? { label: selection.fileName.slice(0, 64) } : {}),
  }
}

/** 校验草稿及网络连接的跳板身份，返回字段错误；TLS 规则与主进程保持一致。 */
export function validateServerOpsDataSourceDraft(draft: ServerOpsDataSourceDraft, hostId = draft.hostId): ServerOpsDataSourceFormErrors {
  /** 待返回的字段错误。 */
  const errors: ServerOpsDataSourceFormErrors = {}
  if (draft.label.trim().length === 0 || draft.label.length > 64) errors.label = '名称必填且不超过 64 个字符'
  if (draft.engine === 'sqlite') {
    if (draft.transport === 'ssh' && draft.hostId === '') errors.hostId = '请选择 SQLite 文件所在的服务器'
    if (draft.transport === 'direct'
      ? !isServerOpsLocalSqliteFilePath(draft.filePath)
      : !isServerOpsSqliteFilePath(draft.filePath)) {
      errors.filePath = draft.transport === 'direct'
        ? '请选择本机上的 SQLite 文件'
        : '请输入服务器上的绝对路径，不能使用 URI、相对路径或内存数据库'
    }
    return errors
  }
  if (draft.transport === 'ssh' && hostId === '') {
    errors.hostId = '经由 SSH 需要一台跳板服务器；请先添加服务器，或改选「直接连接」'
  }
  if (draft.address.trim().length === 0 || draft.address.length > 255 || /\s/u.test(draft.address)) {
    errors.address = '地址必填、不超过 255 个字符且不能包含空白'
  }
  /** 归一化后的端口数字。 */
  const port = Number(draft.port)
  if (!/^\d+$/u.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.port = '端口必须是 1 到 65535 之间的整数'
  }
  if (draft.engine === 'redis' && draft.database.trim() !== '') {
    /** Redis 逻辑库序号的数字形式。 */
    const databaseIndex = Number(draft.database)
    if (!/^\d{1,2}$/u.test(draft.database) || databaseIndex < 0 || databaseIndex > 15) {
      errors.database = 'Redis 逻辑库必须是 0 到 15 之间的数字'
    }
  }
  if (draft.engine === 'redis' && draft.tlsMode === 'preferred') {
    errors.tlsMode = 'Redis 不支持优先 TLS 协商，请选择必须 TLS 或校验证书'
  }
  if (draft.tlsMode === 'verify'
    && ((draft.tlsServerName.trim() || draft.address.trim()).length > 255 || /\s/u.test(draft.tlsServerName.trim() || draft.address.trim()))) {
    errors.tlsServerName = '证书主机名不能超过 255 个字符或包含空白'
  }
  if (draft.engine === 'mysql' && draft.tlsMode === 'verify' && errors.tlsServerName === undefined
    && !isServerOpsMySqlTlsServerName(draft.tlsServerName.trim() || draft.address.trim())) {
    errors.tlsServerName = '请填写证书中的 DNS 主机名；数据库地址仍可使用 IP'
  }
  if (!errors.address && draft.transport === 'direct' && draft.tlsMode === 'disabled'
    && !isServerOpsPlaintextDirectAddress(draft.address)) {
    errors.tlsMode = '该域名或公网地址直连需要开启 TLS；关闭 TLS 只适用于回环或私有网段'
  }
  return errors
}

/**
 * 把表单草稿转换为一次性的连接测试输入。
 *
 * 密码来源二选一：本次表单里新填的明文，或编辑态复用的已保存密文（`savedSourceId`）；
 * 勾选"清除已保存密码"后不再复用旧密文。
 *
 * @param options 跳板主机、编辑目标与当前草稿
 * @returns 可测试的草稿输入；端口非法或缺少跳板主机时返回 null
 */
export function buildServerOpsDataSourceProbeDraft(options: {
  /** 表单当前可用的跳板主机；新建时由调用方给出。 */
  hostId: string
  source: ServerOpsDataSource | null
  draft: ServerOpsDataSourceDraft
  /** 密码框里的明文是否来自"已保存密码"；是则本次测试复用主进程密文。 */
  passwordFromStore?: boolean
}): ServerOpsDataSourceProbeDraft | null {
  const { source, draft } = options
  if (draft.engine === 'sqlite') {
    const transport = source?.transport ?? draft.transport
    const jumpHostId = source?.hostId ?? draft.hostId ?? options.hostId
    const validPath = transport === 'direct'
      ? isServerOpsLocalSqliteFilePath(draft.filePath)
      : isServerOpsSqliteFilePath(draft.filePath)
    if (!validPath || (transport === 'ssh' && jumpHostId === '')) return null
    return {
      transport,
      ...(transport === 'ssh' ? { hostId: jumpHostId } : {}),
      engine: 'sqlite',
      filePath: draft.filePath.trim(),
      database: 'main',
      tlsMode: 'disabled',
    }
  }
  /** 归一化后的端口；非法时无法构造运行时请求。 */
  const port = Number(draft.port)
  if (!/^\d+$/u.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65_535) return null
  /** 经由跳板时使用的跳板主机 ID。 */
  const jumpHostId = source?.hostId ?? options.hostId
  if (draft.transport === 'ssh' && jumpHostId === '') return null
  /** 本次是否使用表单里新填的密码；来自已保存密文时按"复用"处理。 */
  const usesInlinePassword = draft.password !== '' && !draft.clearPassword && options.passwordFromStore !== true
  /** 只有编辑既有记录、没有新密码、也没有勾选清除时才复用已保存密文。 */
  const reusesSavedPassword = !usesInlinePassword && draft.clearPassword !== true
    && source !== null
    && (source.hasPassword === true || options.passwordFromStore === true)
  return {
    transport: draft.transport,
    ...(draft.transport === 'ssh' ? { hostId: jumpHostId } : {}),
    engine: draft.engine,
    address: draft.address.trim(),
    port,
    ...(draft.engine === 'redis' && draft.database.trim() !== '' ? { database: draft.database.trim() } : {}),
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    ...(usesInlinePassword ? { password: draft.password } : {}),
    ...(reusesSavedPassword ? { savedSourceId: source!.id } : {}),
    tlsMode: draft.tlsMode,
    ...(draft.tlsMode === 'verify' ? { tlsServerName: draft.tlsServerName.trim() || draft.address.trim() } : {}),
  }
}

/**
 * 把已通过前端校验的草稿转换为共享写入输入。
 *
 * @param options 主机、编辑目标与草稿
 * @returns 严格符合共享合同的写入输入
 */
export function buildServerOpsDataSourceUpsertInput(options: {
  hostId: string
  source: ServerOpsDataSource | null
  draft: ServerOpsDataSourceDraft
  /**
   * 密码框里的明文是否来自"已保存密码"。
   *
   * 展示已保存密码只是让人看清，不代表用户改了密码：
   * 这种状态下不提交 `password`，主进程保持原密文不变。
   */
  passwordFromStore?: boolean
}): ServerOpsDataSourceUpsertInput {
  const { hostId, source, draft } = options
  if (draft.engine === 'sqlite') {
    const transport = source?.transport ?? draft.transport
    return {
      transport,
      ...(transport === 'ssh' ? { hostId: source?.hostId ?? draft.hostId ?? hostId } : {}),
      ...(source ? { sourceId: source.id } : {}),
      engine: 'sqlite',
      label: draft.label,
      filePath: draft.filePath.trim(),
      database: 'main',
      tlsMode: 'disabled',
    }
  }
  /** 是否应当把密码框内容当作"本次新密码"提交。 */
  const submitsPassword = draft.password !== '' && options.passwordFromStore !== true
  return {
    transport: draft.transport,
    ...(draft.transport === 'ssh' ? { hostId: source?.hostId ?? hostId } : {}),
    ...(source ? { sourceId: source.id } : {}),
    engine: draft.engine,
    label: draft.label,
    address: draft.address,
    port: Number(draft.port),
    ...(draft.engine === 'redis' && draft.database.trim() !== '' ? { database: draft.database.trim() } : {}),
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    ...(submitsPassword ? { password: draft.password } : {}),
    ...(draft.clearPassword ? { clearPassword: true } : {}),
    tlsMode: draft.tlsMode,
    ...(draft.tlsMode === 'verify' ? { tlsServerName: draft.tlsServerName.trim() || draft.address.trim() } : {}),
  }
}

/** 数据源表单字段属性；受控组件便于静态断言。 */
export interface ServerOpsDataSourceFieldsProps {
  draft: ServerOpsDataSourceDraft
  errors: ServerOpsDataSourceFormErrors
  mode: 'create' | 'edit'
  /** 编辑目标是否已有保存的密码，决定是否展示清除入口。 */
  hasSavedPassword: boolean
  /** 密码输入是否明文显示。 */
  showPassword: boolean
  onChange: (patch: Partial<ServerOpsDataSourceDraft>) => void
  onConnectionModeChange: (mode: ServerOpsDataConnectionMode) => void
  onEngineChange: (engine: ServerOpsDataEngine) => void
  /**
   * 切换密码明文显示。
   *
   * 编辑态且密码框为空时由外层先向主进程取回已保存的明文，再切到明文显示，
   * 因此这里返回 Promise，按钮在取回期间显示加载态。
   */
  onShowPasswordChange: (showPassword: boolean) => void | Promise<void>
  /** 取回已保存密码期间为 true；此时眼睛按钮禁用并显示加载态。 */
  revealingPassword?: boolean
  /** 当前明文是否来自"已保存密码"（而不是用户新输入的）。 */
  passwordFromStore?: boolean
  /** 网络连接当前可用的跳板身份；为空时禁选无效的 SSH 路径。 */
  hostId: string
  /** 跳板主机展示名；用于连接方式选项文案。 */
  hostLabel: string
  /** 当前项目内可作为 SQLite 文件宿主的服务器。 */
  hostOptions?: readonly ServerOpsDataSourceHostOption[]
  /** 打开本机文件选择器；仅本地 SQLite 模式显示。 */
  onSelectLocalFile?: () => void
}

/** SQLite 服务器选择只需要稳定 ID 与可辨认名称。 */
export interface ServerOpsDataSourceHostOption {
  id: string
  label: string
}

/** 数据源表单字段集合。 */
export function ServerOpsDataSourceFields({
  draft,
  errors,
  mode,
  hasSavedPassword,
  showPassword,
  onChange,
  onConnectionModeChange,
  onEngineChange,
  onShowPasswordChange,
  revealingPassword = false,
  passwordFromStore = false,
  hostId,
  hostLabel,
  hostOptions = [],
  onSelectLocalFile,
}: ServerOpsDataSourceFieldsProps): React.ReactElement {
  /** 固定星号只表示已有凭据，不读取真实密码，也不作为草稿提交。 */
  const hasRetainedPassword = mode === 'edit' && hasSavedPassword && !draft.clearPassword
  /** 本地文件是表单层独立模式，提交仍使用 direct + sqlite。 */
  const connectionMode = getServerOpsDataConnectionMode(draft)
  return (
    <div className="grid gap-4 [&_label]:text-xs" data-server-ops-data-source-form="true">
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-transport">连接方式</Label>
          <Select value={connectionMode} disabled={mode === 'edit'} onValueChange={(value) => onConnectionModeChange(value as ServerOpsDataConnectionMode)}>
            <SelectTrigger id="server-ops-data-transport" aria-label="连接方式"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[280]">
              <SelectItem value="direct">直接连接（本机发起）</SelectItem>
              <SelectItem value="ssh" disabled={!hostId && hostOptions.length === 0}>{hostLabel ? `经由 SSH · ${hostLabel}` : '经由 SSH 服务器'}</SelectItem>
              <SelectItem value="local-sqlite">本地数据库（SQLite）</SelectItem>
            </SelectContent>
          </Select>
          {draft.engine === 'sqlite' ? <p className="text-[11px] text-muted-foreground">当前：{connectionMode === 'local-sqlite' ? '本地数据库（SQLite）' : 'SSH 服务器文件'}{mode === 'edit' ? '；如需切换，请新建连接' : ''}</p> : null}
          {errors.hostId ? <p className="text-[11px] text-destructive">{errors.hostId}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-engine">引擎</Label>
          <Select value={draft.engine} disabled={connectionMode === 'local-sqlite'} onValueChange={(value) => onEngineChange(value as ServerOpsDataEngine)}>
            <SelectTrigger id="server-ops-data-engine" aria-label="引擎"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[280]">
              {getServerOpsDataConnectionModeEngines(connectionMode).map((engine) => (
                <SelectItem key={engine} value={engine}>{engine === 'mysql' ? 'MySQL' : engine === 'redis' ? 'Redis' : 'SQLite'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {/* 网络数据库将名称与 TLS 同排；SQLite 无 TLS，名称继续占满行宽。 */}
        <div className={cn('grid min-w-0 gap-1.5', draft.engine === 'sqlite' && 'sm:col-span-2')}>
          <Label htmlFor="server-ops-data-label">名称</Label>
          <Input id="server-ops-data-label" value={draft.label} placeholder="业务主库" onChange={(event) => onChange({ label: event.target.value })} />
          {errors.label ? <p className="text-[11px] text-destructive">{errors.label}</p> : null}
        </div>
        {draft.engine !== 'sqlite' ? <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="server-ops-data-tls">TLS</Label>
          <Select value={draft.tlsMode} onValueChange={(value) => onChange({ tlsMode: value as ServerOpsDataTlsMode })}>
            <SelectTrigger id="server-ops-data-tls" aria-label="TLS 模式"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[280]">
              <SelectItem value="disabled">关闭（仅 SSH / 内网直连）</SelectItem>
              {draft.engine === 'mysql' ? <SelectItem value="preferred">优先 TLS</SelectItem> : null}
              <SelectItem value="required">必须 TLS</SelectItem>
              <SelectItem value="verify">校验证书</SelectItem>
            </SelectContent>
          </Select>
          {errors.tlsMode ? <p className="text-[11px] text-destructive">{errors.tlsMode}</p> : null}
        </div> : null}
      </div>
      {draft.engine === 'sqlite' ? (
        <div className="grid gap-3">
          {draft.transport === 'ssh' ? <div className="grid gap-1.5">
            <Label htmlFor="server-ops-data-host">服务器</Label>
            <Select value={draft.hostId} disabled={mode === 'edit'} onValueChange={(hostId) => onChange({ hostId })}>
              <SelectTrigger id="server-ops-data-host" aria-label="服务器"><SelectValue placeholder="选择文件所在服务器" /></SelectTrigger>
              <SelectContent className="z-[280]">
                {hostOptions.map((host) => <SelectItem key={host.id} value={host.id}>{host.label}</SelectItem>)}
              </SelectContent>
            </Select>
            {errors.hostId ? <p className="text-[11px] text-destructive">{errors.hostId}</p> : null}
          </div> : null}
          <div className="grid gap-1.5">
            <Label htmlFor="server-ops-data-file-path">SQLite 文件路径</Label>
            <div className="flex min-w-0 gap-2">
              <Input id="server-ops-data-file-path" value={draft.filePath} readOnly={draft.transport === 'direct'} title={draft.filePath}
                placeholder={draft.transport === 'direct' ? '选择本机 SQLite 文件' : '/srv/data/app.sqlite3'}
                onChange={(event) => onChange({ filePath: event.target.value })} />
              {draft.transport === 'direct' ? <Button type="button" variant="outline" className="shrink-0 gap-1.5" onClick={onSelectLocalFile}>
                <FileUp className="size-3.5" aria-hidden="true" />选择 SQLite 文件
              </Button> : null}
            </div>
            <p className="text-[11px] text-muted-foreground">{draft.transport === 'direct'
              ? '原地只读打开本机文件，不复制数据库；移动或替换文件后需重新添加连接。'
              : '填写服务器上的绝对路径；服务器需安装 Python 3.11+ 并包含 sqlite3 标准库。'}</p>
            {errors.filePath ? <p className="text-[11px] text-destructive">{errors.filePath}</p> : null}
          </div>
        </div>
      ) : <>
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-[minmax(0,1fr)_6rem]">
        <div className="grid min-w-0 gap-1.5">
          <Label htmlFor="server-ops-data-address">{draft.transport === 'ssh' ? '数据库地址（跳板服务器视角）' : '数据库地址'}</Label>
          <Input id="server-ops-data-address" value={draft.address} title={draft.address} placeholder="数据库域名或 IP" onChange={(event) => onChange({ address: event.target.value })} />
          {errors.address ? <p className="text-[11px] text-destructive">{errors.address}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-port">端口</Label>
          <Input id="server-ops-data-port" inputMode="numeric" value={draft.port} onChange={(event) => onChange({ port: event.target.value })} />
          {errors.port ? <p className="text-[11px] text-destructive">{errors.port}</p> : null}
        </div>
        <div className="text-[11px] leading-5 text-muted-foreground sm:col-span-2">
          {draft.transport === 'direct' ? <p>直接连接支持远程域名与 IP，无需添加服务器。</p>
            : !hostId ? <p>当前项目没有可用的 SSH 服务器，请先添加服务器或选择直接连接。</p>
              : <p>填写跳板服务器能够访问的数据库域名或 IP。</p>}
        </div>
      </div>
      {draft.engine === 'redis' ? <div className="grid gap-1.5">
        <Label htmlFor="server-ops-data-database">逻辑库（0-15）</Label>
        <Input
          id="server-ops-data-database"
          value={draft.database}
          placeholder="0"
          onChange={(event) => onChange({ database: event.target.value })}
        />
        {errors.database ? <p className="text-[11px] text-destructive">{errors.database}</p> : null}
      </div> : null}
      {draft.tlsMode === 'preferred' ? <p className="rounded-lg bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">优先使用 TLS；仅服务器明确不支持时允许明文回退。</p> : null}
      {draft.tlsMode === 'required' ? <p className="rounded-lg bg-muted/30 px-3 py-2.5 text-xs leading-5 text-muted-foreground">必须加密连接，不校验证书身份；需要验证身份时选择「校验证书」。</p> : null}
      {draft.tlsMode === 'verify' ? (
        <div className="grid gap-1.5 rounded-lg bg-muted/30 p-3">
          <Label htmlFor="server-ops-data-tls-name">数据库真实主机名</Label>
          <Input
            id="server-ops-data-tls-name"
            value={draft.tlsServerName}
            placeholder={draft.address ? `默认：${draft.address}` : 'db.internal'}
            onChange={(event) => onChange({ tlsServerName: event.target.value })}
          />
          <p className="text-[11px] leading-5 text-muted-foreground">校验名默认跟随数据库地址，可按证书手动修改；不要填写 SSH 跳板地址。{draft.engine === 'mysql' ? 'MySQL 此处需填写证书中的 DNS 主机名。' : ''}</p>
          {errors.tlsServerName ? <p className="text-[11px] text-destructive">{errors.tlsServerName}</p> : null}
        </div>
      ) : null}
      {/*
        关闭 TLS 时提前把后果讲清楚：私有网段允许明文直连（会有可见标记），
        其它地址则会被主进程拒绝，避免用户保存了一个永远连不上的配置。
      */}
      {draft.tlsMode !== 'disabled' ? null : draft.transport === 'direct' && isServerOpsPlaintextDirectAddress(draft.address) ? (
        <p className="rounded-lg bg-amber-500/5 px-3 py-2.5 text-xs leading-5 text-amber-700 dark:text-amber-400" data-server-ops-data-plaintext-hint>
          该地址属于内网私有网段：允许关闭 TLS 直连，但密码与查询结果会以内网明文传输，连接列表会标记「内网明文」。
        </p>
      ) : draft.transport === 'direct' ? (
        <p className="rounded-lg bg-destructive/5 px-3 py-2.5 text-xs leading-5 text-destructive" data-server-ops-data-tls-required-hint>
          域名和公网 IP 支持直连，但需要开启 TLS；关闭 TLS 仅允许回环或私有网段地址。
        </p>
      ) : null}
      <div className="grid gap-3 border-t border-border/40 pt-4">
        <div className="text-xs font-medium text-muted-foreground">登录凭据</div>
        {/* 用户名与密码顶端对齐，说明和清除入口只占密码列；窄窗口自动换行。 */}
        <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2">
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="server-ops-data-username">用户名</Label>
            <Input id="server-ops-data-username" value={draft.username} placeholder="可选" onChange={(event) => onChange({ username: event.target.value })} />
          </div>
          <div className="grid min-w-0 gap-1.5">
            <Label htmlFor="server-ops-data-password">密码</Label>
            <div className="relative">
              <Input
                id="server-ops-data-password"
                type={showPassword ? 'text' : 'password'}
                value={draft.password}
                placeholder={hasRetainedPassword && !showPassword ? '********' : '可选'}
                autoComplete="new-password"
                spellCheck={false}
                className="pr-10"
                disabled={draft.clearPassword}
                onChange={(event) => onChange({ password: event.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="absolute right-1 top-1 text-muted-foreground hover:text-foreground"
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                aria-pressed={showPassword}
                disabled={revealingPassword || draft.clearPassword}
                onClick={() => { void onShowPasswordChange(!showPassword) }}
              >
                {revealingPassword
                  ? <LoaderCircle className="size-3.5 animate-spin" />
                  : showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
              </Button>
            </div>
            {passwordFromStore ? (
              <p className="text-[11px] leading-5 text-muted-foreground" data-server-ops-data-password-from-store>
                正在显示已保存密码，修改后才会替换。
              </p>
            ) : hasRetainedPassword && draft.password === '' ? (
              <p className="text-[11px] leading-5 text-muted-foreground">已保存密码，输入新密码可替换。</p>
            ) : null}
            {mode === 'edit' && hasSavedPassword ? (
              <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  className="size-3.5 rounded border-border accent-primary"
                  checked={draft.clearPassword}
                  onChange={(event) => onChange({ clearPassword: event.target.checked, ...(event.target.checked ? { password: '' } : {}) })}
                  aria-label="清除已保存密码"
                />
                清除已保存密码
              </label>
            ) : null}
          </div>
        </div>
      </div>
      </>}
    </div>
  )
}

/** 数据源表单弹窗属性。 */
export interface ServerOpsDataSourceDialogProps {
  open: boolean
  /** 工作台展开时，设置弹窗置于展开宿主上方。 */
  elevated?: boolean
  mode: 'create' | 'edit'
  source: ServerOpsDataSource | null
  /** 新建时的初始引擎；由"添加数据库 / 添加 Redis"入口指定。 */
  initialEngine?: ServerOpsDataEngine
  /** Agent 草稿只包含公开字段，用户仍在原弹窗提供凭据并测试。 */
  initialDraft?: Extract<ServerOpsConnectionDraftInput, { kind: 'mysql' | 'redis' | 'sqlite' }> | null
  hostId: string
  hostLabel: string
  /** 新建 SQLite 时列出当前项目全部服务器；编辑态只展示原宿主。 */
  hostOptions?: readonly ServerOpsDataSourceHostOption[]
  submitting: boolean
  error?: string | null
  /**
   * 用当前草稿做一次真实连接测试；不保存任何设置、不落盘密码。
   *
   * 旧客户端没有这个方法时按钮不渲染，避免出现一个点了必然报错的入口。
   */
  onTest?: (draft: ServerOpsDataSourceProbeDraft) => Promise<ServerOpsDataProbeResult>
  /**
   * 读取已保存的密码明文；只在用户点"显示密码"时调用。
   *
   * 与模型配置里"编辑时加载明文 API Key"同一思路：用户显式要求才取回，
   * 没有保存密码或旧客户端不支持时返回 null。
   */
  onRevealPassword?: (sourceId: string) => Promise<string | null>
  /** 提交已通过前端校验的写入输入；主进程会再做一次严格校验。 */
  onSubmit: (input: ServerOpsDataSourceUpsertInput) => void
  onClose: () => void
}

/** 弹窗状态 Hook 的输入；保持异步能力与视图属性分离，便于验证生命周期竞态。 */
export interface ServerOpsDataSourceDialogControllerOptions {
  open: boolean
  mode: 'create' | 'edit'
  source: ServerOpsDataSource | null
  initialEngine?: ServerOpsDataEngine
  initialDraft?: Extract<ServerOpsConnectionDraftInput, { kind: 'mysql' | 'redis' | 'sqlite' }> | null
  hostId: string
  onTest?: (draft: ServerOpsDataSourceProbeDraft) => Promise<ServerOpsDataProbeResult>
  onRevealPassword?: (sourceId: string) => Promise<string | null>
}

/** 弹窗状态 Hook 暴露给视图的状态与动作。 */
export interface ServerOpsDataSourceDialogController {
  draft: ServerOpsDataSourceDraft
  errors: ServerOpsDataSourceFormErrors
  showPassword: boolean
  passwordFromStore: boolean
  revealingPassword: boolean
  testing: boolean
  testResult: ServerOpsDataProbeResult | null
  testError: string | null
  patchDraft: (patch: Partial<ServerOpsDataSourceDraft>) => void
  changeConnectionMode: (mode: ServerOpsDataConnectionMode) => void
  changeEngine: (engine: ServerOpsDataEngine) => void
  setPasswordVisibility: (showPassword: boolean) => Promise<void>
  testConnection: () => Promise<void>
  setErrors: React.Dispatch<React.SetStateAction<ServerOpsDataSourceFormErrors>>
}

/** 单次打开弹窗的异步身份；切来源、关闭或重开都会创建新代次。 */
interface ServerOpsDataSourceDialogAsyncSession {
  alive: boolean
  draftRevision: number
  revealRequestRevision: number
  testRequestRevision: number
}

/** 创建一个尚未接收用户操作的弹窗异步会话。 */
function createServerOpsDataSourceDialogAsyncSession(alive: boolean): ServerOpsDataSourceDialogAsyncSession {
  return {
    alive,
    draftRevision: 0,
    revealRequestRevision: 0,
    testRequestRevision: 0,
  }
}

/**
 * 管理数据源弹窗状态，并阻止旧来源、旧打开代次或旧草稿的异步回执写回。
 *
 * @param options 当前弹窗身份与异步能力
 * @returns 弹窗视图使用的状态和动作
 */
export function useServerOpsDataSourceDialogController(
  options: ServerOpsDataSourceDialogControllerOptions,
): ServerOpsDataSourceDialogController {
  const { open, mode, source, initialEngine = 'mysql', initialDraft, hostId, onTest, onRevealPassword } = options
  /** 当前草稿。 */
  const [draft, setDraft] = React.useState<ServerOpsDataSourceDraft>(() => createServerOpsDataSourceDraft(source, initialEngine, initialDraft))
  /** 字段级错误。 */
  const [errors, setErrors] = React.useState<ServerOpsDataSourceFormErrors>({})
  /** 密码是否明文显示。 */
  const [showPassword, setShowPassword] = React.useState(false)
  /** 当前密码明文是否来自安全存储。 */
  const [passwordFromStore, setPasswordFromStore] = React.useState(false)
  /** 是否正在读取已保存密码。 */
  const [revealingPassword, setRevealingPassword] = React.useState(false)
  /** 是否正在执行连接测试。 */
  const [testing, setTesting] = React.useState(false)
  /** 最近一次连接测试结论。 */
  const [testResult, setTestResult] = React.useState<ServerOpsDataProbeResult | null>(null)
  /** 最近一次读取或测试错误。 */
  const [testError, setTestError] = React.useState<string | null>(null)
  /** 当前打开代次的异步身份。 */
  const asyncSessionRef = React.useRef<ServerOpsDataSourceDialogAsyncSession>(createServerOpsDataSourceDialogAsyncSession(false))
  /** 是否已手动指定与数据库地址不同的证书名；仅在当前弹窗会话内有效。 */
  const manualTlsNameRef = React.useRef(source?.tlsServerName !== undefined && source.tlsServerName !== source.address)

  useServerOpsDialogLayoutEffect(() => {
    /** 上一代所有在途回执从此失效。 */
    asyncSessionRef.current.alive = false
    /** 本次 open/source/mode 组合使用的独立会话。 */
    const session = createServerOpsDataSourceDialogAsyncSession(open)
    asyncSessionRef.current = session
    if (open) {
      manualTlsNameRef.current = source?.tlsServerName !== undefined && source.tlsServerName !== source.address
      // 每次打开都按当前数据源重建草稿，避免把上一次编辑的半成品带进新表单。
      setDraft(createServerOpsDataSourceDraft(source, initialEngine, initialDraft))
      setErrors({})
      setShowPassword(false)
      setPasswordFromStore(false)
      setRevealingPassword(false)
      setTesting(false)
      setTestResult(null)
      setTestError(null)
    }
    return () => {
      session.alive = false
    }
  }, [hostId, initialEngine, initialDraft, mode, open, source])

  /** 合并草稿字段，并推进草稿代次使旧异步结果立即失效。 */
  const patchDraft = React.useCallback((patch: Partial<ServerOpsDataSourceDraft>): void => {
    asyncSessionRef.current.draftRevision += 1
    /** 用户亲手改过密码框后，明文的来源就不再是"已保存密码"。 */
    if ('password' in patch) setPasswordFromStore(false)
    if (patch.clearPassword) setShowPassword(false)
    if ('tlsServerName' in patch) manualTlsNameRef.current = patch.tlsServerName !== ''
    setDraft((current) => {
      /** 数据库地址与证书名保持同步，直到用户明确手动覆盖后停止跟随。 */
      const followAddress = !manualTlsNameRef.current && 'address' in patch
        ? { tlsServerName: patch.address ?? '' } : {}
      const next = { ...current, ...followAddress, ...patch }
      if (patch.tlsMode === 'verify' && !('tlsServerName' in patch) && next.tlsServerName === '') next.tlsServerName = next.address
      return next
    })
    // 切换路径或改正字段后清除旧校验，避免仍提示已不存在的跳板/TLS 问题。
    setErrors({})
    setTestResult(null)
    setTestError(null)
  }, [])

  /** 切换引擎并推进草稿代次。 */
  const changeEngine = React.useCallback((engine: ServerOpsDataEngine): void => {
    asyncSessionRef.current.draftRevision += 1
    if (engine === 'sqlite') manualTlsNameRef.current = false
    setDraft((current) => applyServerOpsDataSourceEngineChange(current, engine))
    setErrors({})
    setTestResult(null)
    setTestError(null)
  }, [])

  /** 切换表单连接方式并清理已不适用的凭据、错误和测试结果。 */
  const changeConnectionMode = React.useCallback((connectionMode: ServerOpsDataConnectionMode): void => {
    asyncSessionRef.current.draftRevision += 1
    manualTlsNameRef.current = false
    setPasswordFromStore(false)
    setShowPassword(false)
    setDraft((current) => applyServerOpsDataConnectionModeChange(current, connectionMode, hostId))
    setErrors({})
    setTestResult(null)
    setTestError(null)
  }, [hostId])

  /** 按当前会话读取已保存密码；任何身份或草稿变化都会丢弃迟到回执。 */
  const setPasswordVisibility = async (nextShowPassword: boolean): Promise<void> => {
    if (!nextShowPassword) {
      /** 隐藏动作立即作废在途回显，迟到密码不得重新打开明文状态。 */
      asyncSessionRef.current.revealRequestRevision += 1
      setRevealingPassword(false)
      setShowPassword(false)
      if (passwordFromStore) {
        /** 只释放取回的旧密码；用户正在编辑的新密码继续保留在草稿里。 */
        setDraft((current) => ({ ...current, password: '' }))
        setPasswordFromStore(false)
      }
      return
    }
    if (draft.clearPassword) return
    if (draft.password !== '' || passwordFromStore) {
      setShowPassword(true)
      return
    }
    if (source === null || !source.hasPassword || !onRevealPassword) {
      setShowPassword(true)
      return
    }
    /** 本次读取绑定的弹窗会话。 */
    const session = asyncSessionRef.current
    /** 本次读取的请求代次。 */
    const requestRevision = ++session.revealRequestRevision
    /** 发起读取时的草稿代次。 */
    const draftRevision = session.draftRevision
    /** 判断回执是否仍属于当前弹窗和最新读取请求。 */
    const isCurrentRequest = (): boolean => session.alive
      && asyncSessionRef.current === session
      && session.revealRequestRevision === requestRevision
    setRevealingPassword(true)
    try {
      /** 主进程返回的已保存明文；null 表示这条连接其实没有密文。 */
      const revealed = await onRevealPassword(source.id)
      if (!isCurrentRequest() || session.draftRevision !== draftRevision) return
      if (revealed === null) {
        setTestError('这条连接没有保存密码，请直接填写')
        return
      }
      setDraft((current) => ({ ...current, password: revealed, clearPassword: false }))
      setPasswordFromStore(true)
      setShowPassword(true)
    } catch (revealFailure) {
      if (!isCurrentRequest() || session.draftRevision !== draftRevision) return
      setTestError(getServerOpsDataErrorMessage(revealFailure))
    } finally {
      if (isCurrentRequest()) setRevealingPassword(false)
    }
  }

  /** 执行一次不落盘的连接测试，并只接纳同一会话、同一草稿的最新回执。 */
  const testConnection = async (): Promise<void> => {
    if (!onTest) return
    /** 测试只校验连接字段，不要求先给尚未保存的连接命名。 */
    const nextErrors = validateServerOpsDataSourceDraft(draft, source?.hostId ?? hostId)
    delete nextErrors.label
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) {
      setTestResult(null)
      setTestError(Object.values(nextErrors)[0] ?? '请检查连接设置')
      return
    }
    /** 本次测试使用的草稿输入。 */
    const probeDraft = buildServerOpsDataSourceProbeDraft({ hostId, source, draft, passwordFromStore })
    if (probeDraft === null) {
      setTestResult(null)
      setTestError(draft.engine === 'sqlite'
        ? '请先选择服务器，并填写有效的 SQLite 绝对文件路径'
        : '请检查连接方式、数据库地址与端口')
      return
    }
    /** 本次测试绑定的弹窗会话。 */
    const session = asyncSessionRef.current
    /** 本次测试的请求代次。 */
    const requestRevision = ++session.testRequestRevision
    /** 发起测试时的草稿代次。 */
    const draftRevision = session.draftRevision
    /** 判断回执是否仍属于当前弹窗和最新测试请求。 */
    const isCurrentRequest = (): boolean => session.alive
      && asyncSessionRef.current === session
      && session.testRequestRevision === requestRevision
    setTesting(true)
    setTestResult(null)
    setTestError(null)
    try {
      /** 当前草稿的真实连接测试结果。 */
      const result = await onTest(probeDraft)
      if (!isCurrentRequest() || session.draftRevision !== draftRevision) return
      setTestResult(result)
    } catch (testFailure) {
      if (!isCurrentRequest() || session.draftRevision !== draftRevision) return
      setTestError(getServerOpsDataErrorMessage(testFailure))
    } finally {
      if (isCurrentRequest()) setTesting(false)
    }
  }

  return {
    draft,
    errors,
    showPassword,
    passwordFromStore,
    revealingPassword,
    testing,
    testResult,
    testError,
    patchDraft,
    changeConnectionMode,
    changeEngine,
    setPasswordVisibility,
    testConnection,
    setErrors,
  }
}

/**
 * 数据源新建/编辑弹窗；密码只在提交时作为明文交给主进程加密保存。
 *
 * @param props 弹窗属性
 * @returns 数据源表单弹窗
 */
export function ServerOpsDataSourceDialog({
  open,
  elevated = false,
  mode,
  source,
  initialEngine = 'mysql',
  initialDraft,
  hostId,
  hostLabel,
  hostOptions = [],
  submitting,
  error,
  onTest,
  onRevealPassword,
  onSubmit,
  onClose,
}: ServerOpsDataSourceDialogProps): React.ReactElement {
  /** 本地 SQLite 使用原生文件输入取得 File，再由 preload 安全解析绝对路径。 */
  const localSqliteInputRef = React.useRef<HTMLInputElement>(null)
  /** 弹窗当前状态与带身份守卫的异步动作。 */
  const controller = useServerOpsDataSourceDialogController({
    open,
    mode,
    source,
    initialEngine,
    initialDraft,
    hostId,
    onTest,
    onRevealPassword,
  })
  const {
    draft,
    errors,
    showPassword,
    passwordFromStore,
    revealingPassword,
    testing,
    testResult,
    testError,
    patchDraft,
    changeConnectionMode,
    changeEngine,
    setPasswordVisibility,
    testConnection,
    setErrors,
  } = controller

  /** 校验后提交。 */
  const submit = (): void => {
    /** 校验后的字段错误。 */
    const nextErrors = validateServerOpsDataSourceDraft(draft, source?.hostId ?? hostId)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit(buildServerOpsDataSourceUpsertInput({ hostId, source, draft, passwordFromStore }))
  }

  /** 将本机文件选择结果写入表单；不读取文件内容，也不在 renderer 生成文件身份。 */
  const selectLocalSqliteFile = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    try {
      const filePath = window.electronAPI.getPathForFile(file)
      if (filePath === '') throw new Error('empty path')
      /** 纯转换同时覆盖名称自动填充与取消不变边界。 */
      const next = applyServerOpsLocalSqliteFileSelection(draft, { filePath, fileName: file.name })
      patchDraft({ filePath: next.filePath, label: next.label })
    } catch {
      setErrors((current) => ({ ...current, filePath: '无法读取所选文件路径，请重新选择' }))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className={cn('max-h-[min(90vh,44rem)] w-[calc(100vw-2rem)] max-w-xl gap-0 overflow-hidden p-0', elevated && 'z-[260]')} overlayClassName={elevated ? 'z-[250]' : undefined}>
        <div className="grid max-h-[min(90vh,44rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader className="space-y-2 px-5 pb-5 pt-5 text-left sm:px-6 sm:pt-6">
            <DialogTitle className="pr-6 text-lg leading-6">{mode === 'create' ? '新建数据源' : '编辑数据源'}</DialogTitle>
            <DialogDescription className="text-xs leading-5">
              {draft.engine === 'sqlite'
                ? draft.transport === 'direct'
                  ? '原地只读打开本机 SQLite 文件；不会复制、修改或创建数据库。'
                  : '通过所选服务器的 SSH 连接只读访问 SQLite 文件；不会下载、复制或创建数据库。'
                : '配置连接信息，密码通过系统安全存储加密保存在本机。'}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 pb-5 sm:px-6 sm:pb-6">
          <div className="grid gap-4">
            <ServerOpsDataSourceFields
              draft={draft}
              errors={errors}
              mode={mode}
              hasSavedPassword={source?.hasPassword === true}
              showPassword={showPassword}
              hostId={source?.hostId ?? hostId}
              hostLabel={hostLabel}
              hostOptions={hostOptions}
              onChange={patchDraft}
              onConnectionModeChange={changeConnectionMode}
              onEngineChange={changeEngine}
              onShowPasswordChange={setPasswordVisibility}
              onSelectLocalFile={() => localSqliteInputRef.current?.click()}
              revealingPassword={revealingPassword}
              passwordFromStore={passwordFromStore}
            />
            <input ref={localSqliteInputRef} type="file" className="sr-only" tabIndex={-1}
              accept=".db,.sqlite,.sqlite3,application/vnd.sqlite3" aria-hidden="true" onChange={selectLocalSqliteFile} />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {/* 连接测试结论就地展示，用户不必先保存再回列表里找结果。 */}
            {testResult ? (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2.5 text-xs leading-5',
                  testResult.capability === 'available'
                    ? 'border-emerald-600/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400'
                    : testResult.capability === 'auth-failed' || testResult.capability === 'permission-denied'
                      ? 'border-amber-600/30 bg-amber-500/5 text-amber-700 dark:text-amber-400'
                      : 'border-destructive/30 bg-destructive/5 text-destructive',
                )}
                data-server-ops-data-test-result={testResult.capability}
              >
                <span>{formatServerOpsDataProbeSummary(testResult)}</span>
                {testResult.warnings.slice(1).map((warning) => (
                  <span key={warning} className="opacity-80">{warning}</span>
                ))}
              </div>
            ) : null}
            {testError ? <p className="text-xs text-destructive" data-server-ops-data-test-error>{testError}</p> : null}
          </div>
          </div>
          <DialogFooter className="flex-row flex-wrap items-center gap-2 border-t border-border/40 bg-muted/20 px-5 py-4 sm:space-x-0 sm:px-6">
          {onTest ? (
            /**
             * 与「编辑服务器」弹窗保持一致：测试是次要动作，靠 `sm:mr-auto` 贴在底部左侧，
             * 不与"取消 / 保存"挤在一起，避免误点主操作。
             */
            <Button
              type="button"
              variant="ghost"
              className="mr-auto"
              data-server-ops-data-test
              disabled={submitting || testing}
              onClick={() => { void testConnection() }}
            >
              {testing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
              {testing ? '测试中...' : '测试'}
            </Button>
          ) : null}
          <Button type="button" variant="outline" className="min-w-20" onClick={onClose} disabled={submitting}>取消</Button>
          <Button type="button" className="min-w-20" onClick={submit} disabled={submitting}>{submitting ? '保存中...' : '保存'}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
