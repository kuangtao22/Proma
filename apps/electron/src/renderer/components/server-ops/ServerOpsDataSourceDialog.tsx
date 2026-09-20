import * as React from 'react'
import { Eye, EyeOff, LoaderCircle, PlugZap } from 'lucide-react'
import type {
  ServerOpsDataEngine,
  ServerOpsDataProbeResult,
  ServerOpsDataSource,
  ServerOpsDataSourceProbeDraft,
  ServerOpsDataSourceUpsertInput,
  ServerOpsDataTlsMode,
  ServerOpsDataTransport,
} from '@proma/shared'
import { isServerOpsPlaintextDirectAddress } from '@proma/shared'
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
const DEFAULT_ENGINE_PORTS: Record<ServerOpsDataEngine, number> = { mysql: 3306, redis: 6379 }

/** Renderer 在提交阶段同步失效旧会话；SSR 静态测试使用普通 Effect 避免无意义警告。 */
const useServerOpsDialogLayoutEffect = typeof window === 'undefined' ? React.useEffect : React.useLayoutEffect

/** 数据源表单草稿；端口保持字符串以支持中间态编辑。 */
export interface ServerOpsDataSourceDraft {
  /** 连接方式：本机直连或经由跳板主机。 */
  transport: ServerOpsDataTransport
  engine: ServerOpsDataEngine
  label: string
  address: string
  port: string
  database: string
  username: string
  password: string
  clearPassword: boolean
  tlsMode: ServerOpsDataTlsMode
  tlsServerName: string
}

/** 表单字段错误集合。 */
export interface ServerOpsDataSourceFormErrors {
  label?: string
  address?: string
  port?: string
  database?: string
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
): ServerOpsDataSourceDraft {
  /** 初始引擎。 */
  const engine = source?.engine ?? initialEngine
  return {
    transport: source?.transport ?? 'direct',
    engine,
    label: source?.label ?? '',
    address: source?.address ?? '127.0.0.1',
    port: String(source?.port ?? DEFAULT_ENGINE_PORTS[engine]),
    database: source?.database ?? '',
    username: source?.username ?? '',
    password: '',
    clearPassword: false,
    tlsMode: source?.tlsMode ?? 'disabled',
    tlsServerName: source?.tlsServerName ?? '',
  }
}

/** 切换引擎：带入默认端口，并在切到 Redis 时清空不适用于逻辑库的库名。 */
export function applyServerOpsDataSourceEngineChange(
  draft: ServerOpsDataSourceDraft,
  engine: ServerOpsDataEngine,
): ServerOpsDataSourceDraft {
  return {
    ...draft,
    engine,
    port: String(DEFAULT_ENGINE_PORTS[engine]),
    ...(engine === 'redis' ? { database: '' } : {}),
  }
}

/** 校验草稿并返回字段级错误；规则必须与共享合同保持一致。 */
export function validateServerOpsDataSourceDraft(draft: ServerOpsDataSourceDraft): ServerOpsDataSourceFormErrors {
  /** 待返回的字段错误。 */
  const errors: ServerOpsDataSourceFormErrors = {}
  if (draft.label.trim().length === 0 || draft.label.length > 64) errors.label = '名称必填且不超过 64 个字符'
  if (draft.address.trim().length === 0 || draft.address.length > 255 || /\s/u.test(draft.address)) {
    errors.address = '地址必填、不超过 255 个字符且不能包含空白'
  }
  /** 归一化后的端口数字。 */
  const port = Number(draft.port)
  if (!/^\d+$/u.test(draft.port) || !Number.isInteger(port) || port < 1 || port > 65_535) {
    errors.port = '端口必须是 1 到 65535 之间的整数'
  }
  if (draft.database.trim() !== '') {
    if (draft.engine === 'redis') {
      /** Redis 逻辑库序号的数字形式。 */
      const databaseIndex = Number(draft.database)
      if (!/^\d{1,2}$/u.test(draft.database) || databaseIndex < 0 || databaseIndex > 15) {
        errors.database = 'Redis 逻辑库必须是 0 到 15 之间的数字'
      }
    } else if (draft.database.length > 64) {
      errors.database = '库名不超过 64 个字符'
    }
  }
  if (draft.tlsMode === 'verify'
    && (draft.tlsServerName.trim().length === 0 || draft.tlsServerName.length > 255 || /\s/u.test(draft.tlsServerName))) {
    errors.tlsServerName = '校验证书时必须填写数据库真实主机名，且不能包含空白'
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
    ...(draft.database.trim() === '' ? {} : { database: draft.database.trim() }),
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    ...(usesInlinePassword ? { password: draft.password } : {}),
    ...(reusesSavedPassword ? { savedSourceId: source!.id } : {}),
    tlsMode: draft.tlsMode,
    ...(draft.tlsMode === 'verify' ? { tlsServerName: draft.tlsServerName.trim() } : {}),
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
    ...(draft.database.trim() === '' ? {} : { database: draft.database.trim() }),
    ...(draft.username.trim() === '' ? {} : { username: draft.username.trim() }),
    ...(submitsPassword ? { password: draft.password } : {}),
    ...(draft.clearPassword ? { clearPassword: true } : {}),
    tlsMode: draft.tlsMode,
    ...(draft.tlsMode === 'verify' ? { tlsServerName: draft.tlsServerName } : {}),
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
  /** 跳板主机展示名；用于连接方式选项文案。 */
  hostLabel: string
}

/** 数据源表单字段集合。 */
export function ServerOpsDataSourceFields({
  draft,
  errors,
  mode,
  hasSavedPassword,
  showPassword,
  onChange,
  onEngineChange,
  onShowPasswordChange,
  revealingPassword = false,
  passwordFromStore = false,
  hostLabel,
}: ServerOpsDataSourceFieldsProps): React.ReactElement {
  return (
    <div className="grid gap-4 py-1 [&_label]:text-xs" data-server-ops-data-source-form="true">
      <div className="text-[11px] font-medium text-muted-foreground">连接信息</div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-transport">连接方式</Label>
          <Select value={draft.transport} onValueChange={(value) => onChange({ transport: value as ServerOpsDataTransport })}>
            <SelectTrigger id="server-ops-data-transport" aria-label="连接方式"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[280]">
              <SelectItem value="direct">本机直连</SelectItem>
              <SelectItem value="ssh">经由 {hostLabel}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-engine">引擎</Label>
          <Select value={draft.engine} onValueChange={(value) => onEngineChange(value as ServerOpsDataEngine)}>
            <SelectTrigger id="server-ops-data-engine" aria-label="引擎"><SelectValue /></SelectTrigger>
            <SelectContent className="z-[280]">
              <SelectItem value="mysql">MySQL</SelectItem>
              <SelectItem value="redis">Redis</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5 sm:col-span-2">
          <Label htmlFor="server-ops-data-label">名称</Label>
          <Input id="server-ops-data-label" value={draft.label} placeholder="业务主库" onChange={(event) => onChange({ label: event.target.value })} />
          {errors.label ? <p className="text-[11px] text-destructive">{errors.label}</p> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(5.5rem,1fr)]">
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-address">服务器视角地址</Label>
          <Input id="server-ops-data-address" value={draft.address} placeholder="127.0.0.1" onChange={(event) => onChange({ address: event.target.value })} />
          {errors.address ? <p className="text-[11px] text-destructive">{errors.address}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-port">端口</Label>
          <Input id="server-ops-data-port" inputMode="numeric" value={draft.port} onChange={(event) => onChange({ port: event.target.value })} />
          {errors.port ? <p className="text-[11px] text-destructive">{errors.port}</p> : null}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-database">{draft.engine === 'redis' ? '逻辑库（0-15）' : '库名'}</Label>
          <Input
            id="server-ops-data-database"
            value={draft.database}
            placeholder={draft.engine === 'redis' ? '0' : '可选'}
            onChange={(event) => onChange({ database: event.target.value })}
          />
          {errors.database ? <p className="text-[11px] text-destructive">{errors.database}</p> : null}
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-username">用户名</Label>
          <Input id="server-ops-data-username" value={draft.username} placeholder="可选" onChange={(event) => onChange({ username: event.target.value })} />
        </div>
      </div>
      <div className="grid gap-1.5 border-t border-border/40 pt-4">
        <div className="text-[11px] font-medium text-muted-foreground">登录凭据</div>
        <Label htmlFor="server-ops-data-password">密码</Label>
        <div className="flex items-center gap-2">
          <Input
            id="server-ops-data-password"
            type={showPassword ? 'text' : 'password'}
            value={draft.password}
            placeholder={mode === 'edit' && hasSavedPassword ? '留空表示保留已保存密码' : '可选'}
            disabled={draft.clearPassword}
            onChange={(event) => onChange({ password: event.target.value })}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={showPassword ? '隐藏密码' : '显示密码'}
            disabled={revealingPassword}
            onClick={() => { void onShowPasswordChange(!showPassword) }}
          >
            {revealingPassword
              ? <LoaderCircle className="size-3.5 animate-spin" />
              : showPassword ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </Button>
        </div>
        {passwordFromStore ? (
          <p className="text-[11px] text-muted-foreground" data-server-ops-data-password-from-store>
            正在显示已保存的密码；不改动密码框则保存时仍保留原密码。
          </p>
        ) : null}
        {mode === 'edit' && hasSavedPassword ? (
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={draft.clearPassword}
              onChange={(event) => onChange({ clearPassword: event.target.checked, ...(event.target.checked ? { password: '' } : {}) })}
              aria-label="清除已保存密码"
            />
            清除已保存密码
          </label>
        ) : null}
      </div>
      <div className="grid gap-1.5 border-t border-border/40 pt-4">
        <div className="text-[11px] font-medium text-muted-foreground">传输安全</div>
        <Label htmlFor="server-ops-data-tls">TLS</Label>
        <Select value={draft.tlsMode} onValueChange={(value) => onChange({ tlsMode: value as ServerOpsDataTlsMode })}>
          <SelectTrigger id="server-ops-data-tls" aria-label="TLS 模式"><SelectValue /></SelectTrigger>
          <SelectContent className="z-[280]">
            <SelectItem value="disabled">关闭</SelectItem>
            <SelectItem value="verify">校验证书</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {draft.tlsMode === 'verify' ? (
        <div className="grid gap-1.5">
          <Label htmlFor="server-ops-data-tls-name">数据库真实主机名</Label>
          <Input
            id="server-ops-data-tls-name"
            value={draft.tlsServerName}
            placeholder="db.internal"
            onChange={(event) => onChange({ tlsServerName: event.target.value })}
          />
          <p className="text-[11px] text-muted-foreground">证书里签发的名字，不是 SSH 跳板地址；隧道不改变证书校验目标。</p>
          {errors.tlsServerName ? <p className="text-[11px] text-destructive">{errors.tlsServerName}</p> : null}
        </div>
      ) : null}
      {/*
        关闭 TLS 时提前把后果讲清楚：私有网段允许明文直连（会有可见标记），
        其它地址则会被主进程拒绝，避免用户保存了一个永远连不上的配置。
      */}
      {draft.tlsMode === 'verify' ? null : draft.transport === 'direct' && isServerOpsPlaintextDirectAddress(draft.address) ? (
        <p className="text-[11px] text-amber-600 dark:text-amber-400" data-server-ops-data-plaintext-hint>
          该地址属于内网私有网段：允许关闭 TLS 直连，但密码与查询结果会以内网明文传输，连接列表会标记「内网明文」。
        </p>
      ) : draft.transport === 'direct' ? (
        <p className="text-[11px] text-destructive" data-server-ops-data-tls-required-hint>
          该地址不在私有网段内（主机名也无法离线判定归属）：关闭 TLS 会被拒绝，请开启证书校验或改用 10./172.16-31./192.168. 这类内网地址。
        </p>
      ) : null}
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
  hostId: string
  hostLabel: string
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
  const { open, mode, source, initialEngine = 'mysql', hostId, onTest, onRevealPassword } = options
  /** 当前草稿。 */
  const [draft, setDraft] = React.useState<ServerOpsDataSourceDraft>(() => createServerOpsDataSourceDraft(source, initialEngine))
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

  useServerOpsDialogLayoutEffect(() => {
    /** 上一代所有在途回执从此失效。 */
    asyncSessionRef.current.alive = false
    /** 本次 open/source/mode 组合使用的独立会话。 */
    const session = createServerOpsDataSourceDialogAsyncSession(open)
    asyncSessionRef.current = session
    if (open) {
      // 每次打开都按当前数据源重建草稿，避免把上一次编辑的半成品带进新表单。
      setDraft(createServerOpsDataSourceDraft(source, initialEngine))
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
  }, [hostId, initialEngine, mode, open, source])

  /** 合并草稿字段，并推进草稿代次使旧异步结果立即失效。 */
  const patchDraft = React.useCallback((patch: Partial<ServerOpsDataSourceDraft>): void => {
    asyncSessionRef.current.draftRevision += 1
    /** 用户亲手改过密码框后，明文的来源就不再是"已保存密码"。 */
    if ('password' in patch) setPasswordFromStore(false)
    setDraft((current) => ({ ...current, ...patch }))
    setTestResult(null)
    setTestError(null)
  }, [])

  /** 切换引擎并推进草稿代次。 */
  const changeEngine = React.useCallback((engine: ServerOpsDataEngine): void => {
    asyncSessionRef.current.draftRevision += 1
    setDraft((current) => applyServerOpsDataSourceEngineChange(current, engine))
    setErrors({})
    setTestResult(null)
    setTestError(null)
  }, [])

  /** 按当前会话读取已保存密码；任何身份或草稿变化都会丢弃迟到回执。 */
  const setPasswordVisibility = async (nextShowPassword: boolean): Promise<void> => {
    if (!nextShowPassword) {
      setShowPassword(false)
      return
    }
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
    /** 本次测试使用的草稿输入。 */
    const probeDraft = buildServerOpsDataSourceProbeDraft({ hostId, source, draft, passwordFromStore })
    if (probeDraft === null) {
      setTestResult(null)
      setTestError('请先填写有效的服务器视角地址与端口；经由跳板时还需要一条可用的服务器')
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
  hostId,
  hostLabel,
  submitting,
  error,
  onTest,
  onRevealPassword,
  onSubmit,
  onClose,
}: ServerOpsDataSourceDialogProps): React.ReactElement {
  /** 弹窗当前状态与带身份守卫的异步动作。 */
  const controller = useServerOpsDataSourceDialogController({
    open,
    mode,
    source,
    initialEngine,
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
    changeEngine,
    setPasswordVisibility,
    testConnection,
    setErrors,
  } = controller

  /** 校验后提交。 */
  const submit = (): void => {
    /** 校验后的字段错误。 */
    const nextErrors = validateServerOpsDataSourceDraft(draft)
    setErrors(nextErrors)
    if (Object.keys(nextErrors).length > 0) return
    onSubmit(buildServerOpsDataSourceUpsertInput({ hostId, source, draft, passwordFromStore }))
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className={cn('max-h-[min(90vh,44rem)] w-[calc(100vw-1rem)] max-w-xl overflow-hidden p-0', elevated && 'z-[260]')} overlayClassName={elevated ? 'z-[250]' : undefined}>
        <div className="grid max-h-[min(90vh,44rem)] min-h-0 grid-rows-[auto_minmax(0,1fr)_auto]">
          <DialogHeader className="px-4 pt-4 sm:px-5 sm:pt-5">
            <DialogTitle className="text-base">{mode === 'create' ? '新建数据源' : '编辑数据源'}</DialogTitle>
            <DialogDescription className="text-xs">
              {draft.transport === 'direct'
                ? '直接在本机访问该地址与端口，密码经系统安全存储加密保存。'
                : `经由 ${hostLabel === '' ? '所选跳板服务器' : hostLabel} 的 SSH 连接访问服务器视角的数据库地址，密码经系统安全存储加密保存。`}
            </DialogDescription>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
          <div className="grid gap-4">
            <ServerOpsDataSourceFields
              draft={draft}
              errors={errors}
              mode={mode}
              hasSavedPassword={source?.hasPassword === true}
              showPassword={showPassword}
              hostLabel={hostLabel}
              onChange={patchDraft}
              onEngineChange={changeEngine}
              onShowPasswordChange={setPasswordVisibility}
              revealingPassword={revealingPassword}
              passwordFromStore={passwordFromStore}
            />
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {/* 连接测试结论就地展示，用户不必先保存再回列表里找结果。 */}
            {testResult ? (
              <div
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-sm border px-2 py-1.5 text-[11px]',
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
          <DialogFooter className="flex-row flex-wrap gap-2 space-x-0 border-t border-border/40 bg-background px-4 py-3 sm:px-5">
          {onTest ? (
            /**
             * 与「编辑服务器」弹窗保持一致：测试是次要动作，靠 `sm:mr-auto` 贴在底部左侧，
             * 不与"取消 / 保存"挤在一起，避免误点主操作。
             */
            <Button
              type="button"
              variant="outline"
              className="mr-auto"
              data-server-ops-data-test
              disabled={submitting || testing}
              onClick={() => { void testConnection() }}
            >
              {testing ? <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
              {testing ? '测试中...' : '测试'}
            </Button>
          ) : null}
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>取消</Button>
          <Button type="button" onClick={submit} disabled={submitting}>{submitting ? '保存中...' : '保存'}</Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}
